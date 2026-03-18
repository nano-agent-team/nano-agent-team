/**
 * AgentManager — Docker lifecycle + NATS health monitoring
 *
 * Responsibilities:
 * - Start a Docker container per loaded agent
 * - Monitor container health via Docker API polling
 * - Monitor agent liveness via NATS heartbeats
 * - Auto-restart dead agents with exponential backoff (max AGENT_RESTART_MAX times)
 */

import fs from 'fs';
import path from 'path';

import Dockerode from 'dockerode';
import type { NatsConnection } from 'nats';

import {
  AGENT_IMAGE,
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  AGENT_RESTART_MAX,
  AGENT_RESTART_DELAY_MS,
  DATA_DIR,
  DB_PATH,
  DOCKER_NETWORK,
  HEALTH_CHECK_INTERVAL_MS,
  NATS_URL,
} from './config.js';
import { logger } from './logger.js';
import type { LoadedAgent } from './agent-registry.js';
import type { ConfigService, NanoConfig } from './config-service.js';
import { codec } from './nats-client.js';

interface ObservabilityConfig {
  level?: string;
  provider?: string;
  endpoints?: { otlp?: string };
}

// ─── Types ───────────────────────────────────────────────────────────────────

type AgentStatus = 'starting' | 'running' | 'dead' | 'restarting';

interface AgentState {
  agentId: string;
  agent: LoadedAgent;
  containerId?: string;
  status: AgentStatus;
  startedAt?: Date;
  restartCount: number;
  lastHeartbeat?: Date;
  busy?: boolean;
  task?: string;
}

interface HeartbeatPayload {
  agentId: string;
  ts: number;
  busy?: boolean;
  task?: string;
}

// ─── AgentManager ────────────────────────────────────────────────────────────

export class AgentManager {
  private states = new Map<string, AgentState>();
  private docker: Dockerode;
  private healthTimer?: NodeJS.Timeout;
  private proxyHost: string | null = null;

  constructor(
    private readonly nc: NatsConnection,
    private readonly configService?: ConfigService,
  ) {
    // Default: connects via /var/run/docker.sock on Linux
    this.docker = new Dockerode();
  }

  /** Returns true when credentials.json exists → use proxy mode */
  private isProxyMode(): boolean {
    return fs.existsSync(path.join(DATA_DIR, 'credentials.json'));
  }

  /** Inspect Docker network to find the gateway IP that worker containers can reach */
  private async resolveProxyHost(): Promise<string> {
    if (DOCKER_NETWORK === 'host') return '127.0.0.1';
    const networkName = DOCKER_NETWORK === 'bridge' ? 'bridge' : DOCKER_NETWORK;
    try {
      const net = await this.docker.getNetwork(networkName).inspect() as {
        IPAM?: { Config?: Array<{ Gateway?: string }> };
      };
      const gateway = net.IPAM?.Config?.[0]?.Gateway;
      if (gateway) return gateway;
    } catch {
      logger.warn('Cannot inspect bridge network, using 172.17.0.1');
    }
    return '172.17.0.1';
  }

  /** Returns cached proxy host, resolving once on first call */
  private async getProxyHost(): Promise<string> {
    if (!this.proxyHost) {
      this.proxyHost = await this.resolveProxyHost();
    }
    return this.proxyHost;
  }

  /** Build Claude env vars: proxy URL in proxy mode, otherwise token-based */
  private async resolveClaudeEnv(): Promise<string[]> {
    if (this.isProxyMode()) {
      const proxyHost = await this.getProxyHost();
      return [`ANTHROPIC_BASE_URL=http://${proxyHost}:8082`];
    }
    const apiKey = await this.resolveApiKey();
    const vars: string[] = [];
    if (apiKey && !apiKey.startsWith('sk-ant-oat')) vars.push(`ANTHROPIC_API_KEY=${apiKey}`);
    if (apiKey && apiKey.startsWith('sk-ant-oat')) vars.push(`CLAUDE_CODE_OAUTH_TOKEN=${apiKey}`);
    if (ANTHROPIC_BASE_URL) vars.push(`ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}`);
    return vars;
  }

  /** Resolve API key: reads fresh OAuth token from credentials file for oauth providers */
  private async resolveApiKey(): Promise<string> {
    if (this.configService) {
      try {
        const config = await this.configService.load();
        // For OAuth, always read fresh token from credentials file (auto-refreshed by Claude Code CLI)
        // Claude Code 2.x stores token in ~/.claude.json; 1.x used ~/.claude/.credentials.json
        if (config?.provider?.type === 'claude-code-oauth') {
          const homeDir = process.env.HOME ?? '/root';
          const credPaths = [
            path.join(homeDir, '.claude.json'),
            path.join(homeDir, '.claude', '.credentials.json'),
          ];
          for (const credPath of credPaths) {
            if (fs.existsSync(credPath)) {
              const creds = JSON.parse(fs.readFileSync(credPath, 'utf8')) as {
                claudeAiOauth?: { accessToken?: string };
              };
              const token = creds.claudeAiOauth?.accessToken;
              if (token) return token;
            }
          }
        }
        if (config?.provider?.apiKey) return config.provider.apiKey;
      } catch { /* fallback */ }
    }
    return ANTHROPIC_API_KEY;
  }

  /** Resolve Codex OAuth token from credentials or config */
  private async resolveCodexToken(config: NanoConfig): Promise<string | undefined> {
    // 1. Check config (set during settings wizard)
    if (config.providers?.codex?.apiKey) return config.providers.codex.apiKey;

    // 2. Read fresh from ~/.codex/auth.json (subscription token auto-refreshed by Codex CLI)
    const homeDir = process.env.HOME ?? '/root';
    const codexAuthPath = path.join(homeDir, '.codex', 'auth.json');
    if (fs.existsSync(codexAuthPath)) {
      try {
        const creds = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8')) as {
          tokens?: { access_token?: string };
        };
        const token = creds.tokens?.access_token;
        if (token) return token;
      } catch { /* ignore */ }
    }

    // 3. Fallback: OpenAI API key from env
    return process.env.OPENAI_API_KEY;
  }

  /** Resolve provider and model for an agent */
  private resolveAgentProvider(agent: LoadedAgent, config: Partial<NanoConfig>): { provider: string; model: string; modelExplicit: boolean } {
    const primaryProvider = config.primaryProvider ?? 'claude';
    const manifest = agent.manifest;

    // Explicit model override → use as-is
    if (manifest.model) {
      const provider = (manifest.provider && manifest.provider !== 'auto')
        ? manifest.provider
        : primaryProvider;
      return { provider, model: manifest.model, modelExplicit: true };
    }

    // Determine provider
    const provider = (manifest.provider && manifest.provider !== 'auto')
      ? manifest.provider
      : primaryProvider;

    // Auto-select model from capabilities + modelMap
    const modelMap = config.providers?.[provider]?.modelMap ?? {};
    const capabilities = manifest.capabilities ?? [];
    const priorityOrder = ['reasoning', 'long-context', 'fast', 'cheap'];
    for (const cap of priorityOrder) {
      if (capabilities.includes(cap) && modelMap[cap]) {
        return { provider, model: modelMap[cap], modelExplicit: false };
      }
    }
    const providerDefaults: Record<string, string> = {
      claude: 'claude-haiku-4-5-20251001',
      codex: 'o4-mini',
      gemini: 'gemini-2.0-flash',
    };
    return { provider, model: modelMap['default'] ?? providerDefaults[provider] ?? 'claude-haiku-4-5-20251001', modelExplicit: false };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async startAll(agents: LoadedAgent[]): Promise<void> {
    for (const agent of agents) {
      await this.startAgent(agent);
    }
  }

  async startAgent(agent: LoadedAgent): Promise<void> {
    const { id } = agent.manifest;
    // When an agent is loaded in team context (root fallback), use team-scoped name
    // to prevent conflicts if multiple teams share the same root agent definition.
    const containerName = agent.teamId ? `nano-agent-${agent.teamId}-${id}` : `nano-agent-${id}`;

    // Initialize state
    this.states.set(id, {
      agentId: id,
      agent,
      status: 'starting',
      restartCount: 0,
    });

    logger.info({ id, containerName }, 'Starting agent container');

    try {
      // Remove stale container if it exists
      await this.removeContainerIfExists(containerName);

      // HOST_DATA_DIR lets Docker daemon (on host) resolve the correct bind path
      // when nano-agent-team's /data volume differs from the host's /data directory.
      const hostDataDir = process.env.HOST_DATA_DIR ?? path.dirname(DB_PATH);
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

      // DB dir for MCP server mount
      const dbDir = hostDataDir;

      // Build env vars for the container
      let config: NanoConfig | null = null;
      if (this.configService) {
        config = await this.configService.load();
      }

      // Resolve provider and model for this agent
      // Vault config override is loaded below after teamConfigBlock — read it early for model resolution
      const vaultConfigPathEarly = path.join(DATA_DIR, 'vault', 'agents', `${id}.json`);
      let vaultConfigEarly: { model?: string } = {};
      if (fs.existsSync(vaultConfigPathEarly)) {
        try { vaultConfigEarly = JSON.parse(fs.readFileSync(vaultConfigPathEarly, 'utf8')); } catch { /* ignore */ }
      }
      const { provider: providerName, model: baseModel, modelExplicit } = this.resolveAgentProvider(agent, config ?? {});
      const model = vaultConfigEarly.model ?? baseModel;
      if (vaultConfigEarly.model) {
        logger.info({ agentId: id, vaultModel: vaultConfigEarly.model, baseModel }, 'Model overridden by vault config');
      }

      // Resolve auth tokens based on provider
      const codexToken = config ? await this.resolveCodexToken(config) : undefined;

      // Read CLAUDE.md and pass as env var — agent dir is mounted from inside nano-live
      // but Docker daemon resolves bind paths on the host where /app/ may not exist.
      const claudeMdPath = path.join(agent.dir, 'CLAUDE.md');
      let claudeMdContent = fs.existsSync(claudeMdPath)
        ? fs.readFileSync(claudeMdPath, 'utf8')
        : '';

      // Resolve team config from config.json (set during team install)
      let repoUrl = process.env.REPO_URL ?? '';
      let githubToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
      let teamConfigBlock = '';
      if (config) {
        try {
          const raw = config as unknown as Record<string, unknown>;
          const teams = raw?.teams as Record<string, { config?: Record<string, unknown> }> | undefined;
          if (teams) {
            for (const [teamId, team] of Object.entries(teams)) {
              const tc = team.config;
              if (tc) {
                if (!repoUrl && typeof tc.repo_url === 'string') repoUrl = tc.repo_url;
                if (!githubToken && typeof tc.github_token === 'string') githubToken = tc.github_token;
                // Build context block with all team config values
                const lines = Object.entries(tc)
                  .filter(([k, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
                  .filter(([k]) => k !== 'github_token') // Don't expose token in CLAUDE.md
                  .map(([k, v]) => `- ${k}: ${v}`);
                if (lines.length > 0) {
                  teamConfigBlock = `\n\n## Konfigurace týmu (${teamId})\n\n${lines.join('\n')}\n`;
                }
              }
            }
          }
        } catch { /* ignore */ }
      }

      // Inject team config into agent's system prompt
      if (teamConfigBlock && claudeMdContent) {
        claudeMdContent += teamConfigBlock;
      }

      // Load vault custom instructions (appended after base CLAUDE.md + team config)
      const customInstructionsPath = path.join(DATA_DIR, 'vault', 'agents', `${id}.md`);
      if (fs.existsSync(customInstructionsPath)) {
        const customContent = fs.readFileSync(customInstructionsPath, 'utf8').trim();
        if (customContent) {
          claudeMdContent += `\n\n## Custom instructions\n\n${customContent}`;
        }
      }

      const env = [
        `NATS_URL=${this.resolveNatsUrl()}`,
        `AGENT_ID=${id}`,
        `SUBSCRIBE_TOPICS=${agent.manifest.subscribe_topics.join(',')}`,
        `PROVIDER=${providerName}`,
        `MODEL=${model}`,
        `MODEL_EXPLICIT=${modelExplicit}`,
        `SESSION_TYPE=${agent.manifest.session_type ?? 'stateless'}`,
        `LOG_LEVEL=info`,
        // Provider-specific auth tokens
        ...(providerName === 'claude' ? await this.resolveClaudeEnv() : []),
        ...(providerName === 'codex' && codexToken ? [
          // Subscription token or API key
          ...(codexToken.startsWith('sk-proj-') || codexToken.startsWith('sk-')
            ? [`OPENAI_API_KEY=${codexToken}`]
            : [`CODEX_OAUTH_TOKEN=${codexToken}`]
          ),
        ] : []),
        ...(providerName === 'gemini' ? [
          ...(config?.providers?.gemini?.apiKey ? [`GEMINI_API_KEY=${config.providers.gemini.apiKey}`] : []),
          ...(process.env.GEMINI_API_KEY ? [`GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`] : []),
        ] : []),
        // Tickets MCP server DB path inside container
        `DB_PATH=/workspace/db/${path.basename(DB_PATH)}`,
        // Pass CLAUDE.md content as env var (avoids Docker bind mount path resolution issues)
        ...(claudeMdContent ? [`AGENT_SYSTEM_PROMPT=${claudeMdContent}`] : []),
        // Pass GitHub token if available (from team config or env vars, for gh CLI and git push)
        ...(githubToken ? [`GH_TOKEN=${githubToken}`] : []),
        // Pass repo URL from config (set during team install)
        ...(repoUrl ? [`REPO_URL=${repoUrl}`] : []),
        // Observability: propagate OTel config to agent containers
        ...await this.getObservabilityEnvVars(),
      ];

      // Volume: agent dir → /workspace/agent (read-only)
      const binds = [`${agent.dir}:/workspace/agent:ro`];

      // Volume: DB dir → /workspace/db (read-write, for MCP tickets server)
      binds.push(`${dbDir}:/workspace/db:rw`);

      // Volume: shared vault → /workspace/vault (read-write, all agents)
      const vaultDir = path.join(hostDataDir, 'vault');
      fs.mkdirSync(vaultDir, { recursive: true });
      binds.push(`${vaultDir}:/workspace/vault:rw`);

      // Volume: per-agent sessions → /workspace/sessions (read-write, Claude SDK storage)
      const sessionDir = path.join(hostDataDir, 'sessions', id);
      fs.mkdirSync(sessionDir, { recursive: true });
      binds.push(`${sessionDir}:/workspace/sessions:rw`);

      // Volume: Provider-specific credentials
      // Claude Code credentials → /root/.claude (read-write for session cache)
      // Claude Code 2.x also needs ~/.claude.json (OAuth token file)
      // Skip in proxy mode: agents use ANTHROPIC_BASE_URL instead of direct auth
      if ((providerName === 'claude' || providerName === 'auto' || !providerName) && !this.isProxyMode()) {
        const claudeDir = path.join(process.env.HOME ?? '/root', '.claude');
        if (fs.existsSync(claudeDir)) {
          binds.push(`${claudeDir}:/root/.claude:rw`);
          logger.debug({ id, claudeDir }, 'Mounting .claude dir (rw)');
        }
        const claudeJson = path.join(process.env.HOME ?? '/root', '.claude.json');
        if (fs.existsSync(claudeJson)) {
          binds.push(`${claudeJson}:/root/.claude.json:rw`);
          logger.debug({ id }, 'Mounting .claude.json (rw)');
        }
      }

      // Codex CLI credentials → /root/.codex (read-write so Codex CLI can refresh tokens)
      // HOST_CODEX_DIR = host path (for Docker bind source)
      // container path /root/.codex = where we check existence
      if (providerName === 'codex') {
        const containerCodexDir = path.join(process.env.HOME ?? '/root', '.codex');
        const hostCodexDir = process.env.HOST_CODEX_DIR ?? containerCodexDir;
        if (fs.existsSync(containerCodexDir)) {
          binds.push(`${hostCodexDir}:/root/.codex:rw`);
          logger.debug({ id, hostCodexDir }, 'Mounting .codex dir (rw)');
        }
      }

      // Volume: SSH keys → /root/.ssh (optional, for agents needing git SSH push)
      if (agent.manifest.ssh_mount) {
        const sshDir = path.join(process.env.HOME ?? '/root', '.ssh');
        if (fs.existsSync(sshDir)) {
          binds.push(`${sshDir}:/root/.ssh:ro`);
          logger.debug({ id, sshDir }, 'Mounting SSH keys');
        } else {
          logger.warn({ id, sshDir }, 'ssh_mount=true but ~/.ssh not found on host');
        }
      }

      // Volume: personal workspace → /workspace/personal (optional, for developer-type agents)
      if (agent.manifest.workspace) {
        const wsDir = path.join(hostDataDir, 'workspaces', id);
        fs.mkdirSync(wsDir, { recursive: true });
        binds.push(`${wsDir}:/workspace/personal:rw`);
        logger.debug({ id, wsDir }, 'Mounting personal workspace');
      }

      // Volume: repo path → /workspace/repo (optional, for git workflow agents)
      if (agent.manifest.repo_path) {
        binds.push(`${agent.manifest.repo_path}:/workspace/repo:rw`);
        logger.debug({ id, repo_path: agent.manifest.repo_path }, 'Mounting repo workspace');
      }

      // Use per-agent image if specified in manifest.
      // Convention: if agents/{id}/Dockerfile exists, image is nano-agent-{id}:latest
      // Otherwise fall back to default AGENT_IMAGE.
      const perAgentImage = `nano-agent-${id}:latest`;
      const hasPerAgentImage = await this.imageExists(perAgentImage);
      const image = agent.manifest.image ?? (hasPerAgentImage ? perAgentImage : AGENT_IMAGE);
      logger.debug({ id, image }, 'Using container image');

      const container = await this.docker.createContainer({
        Image: image,
        name: containerName,
        Env: env,
        HostConfig: {
          Binds: binds,
          NetworkMode: DOCKER_NETWORK,
          RestartPolicy: { Name: 'no' }, // We handle restarts ourselves
        },
      });

      await container.start();

      const state = this.states.get(id)!;
      state.containerId = container.id;
      state.status = 'running';
      state.startedAt = new Date();

      logger.info(
        { id, containerId: container.id.slice(0, 12) },
        'Agent container started',
      );
    } catch (err) {
      logger.error({ err, id }, 'Failed to start agent container');
      const state = this.states.get(id);
      if (state) state.status = 'dead';
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    const state = this.states.get(agentId);
    if (!state?.containerId) return;

    const containerName = `nano-agent-${agentId}`;
    logger.info({ agentId, containerName }, 'Stopping agent container');

    try {
      const container = this.docker.getContainer(state.containerId);
      await container.stop({ t: 30 }).catch(() => {}); // 30s for graceful shutdown
      await container.remove({ force: true }).catch(() => {});
      state.status = 'dead';
      logger.info({ agentId }, 'Agent container stopped');
    } catch (err) {
      logger.warn({ err, agentId }, 'Error stopping agent container');
    }
  }

  getAgent(agentId: string): LoadedAgent | undefined {
    return this.states.get(agentId)?.agent;
  }

  /**
   * Return current agent states snapshot (for health API).
   */
  getStates(): Array<{
    agentId: string;
    status: AgentStatus;
    restartCount: number;
    startedAt?: string;
    lastHeartbeat?: string;
    containerId?: string;
    busy?: boolean;
    task?: string;
  }> {
    return [...this.states.values()].map((s) => ({
      agentId: s.agentId,
      status: s.status,
      restartCount: s.restartCount,
      startedAt: s.startedAt?.toISOString(),
      lastHeartbeat: s.lastHeartbeat?.toISOString(),
      containerId: s.containerId?.slice(0, 12),
      busy: s.busy,
      task: s.task,
    }));
  }

  async stopAll(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }

    await Promise.allSettled(
      [...this.states.keys()].map((id) => this.stopAgent(id)),
    );
  }

  startHealthMonitoring(): void {
    this.subscribeHeartbeats();

    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, HEALTH_CHECK_INTERVAL_MS);

    logger.info(
      { intervalMs: HEALTH_CHECK_INTERVAL_MS },
      'Health monitoring started',
    );
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async checkHealth(): Promise<void> {
    for (const [agentId, state] of this.states.entries()) {
      if (state.status !== 'running') continue;
      if (!state.containerId) continue;

      try {
        const container = this.docker.getContainer(state.containerId);
        const info = await container.inspect();

        if (!info.State.Running) {
          logger.warn(
            { agentId, exitCode: info.State.ExitCode },
            'Agent container is not running',
          );
          await this.handleDeadAgent(agentId);
          continue;
        }

        // Check heartbeat staleness only after agent has had time to start
        const uptimeMs = state.startedAt
          ? Date.now() - state.startedAt.getTime()
          : 0;

        if (uptimeMs > 60_000 && state.lastHeartbeat) {
          const staleness = Date.now() - state.lastHeartbeat.getTime();
          if (staleness > 60_000) {
            logger.warn(
              { agentId, staleness: Math.round(staleness / 1000) + 's' },
              'Agent heartbeat is stale — container may be stuck',
            );
          }
        }
      } catch (err) {
        logger.error({ err, agentId }, 'Error inspecting agent container');
        await this.handleDeadAgent(agentId);
      }
    }
  }

  private async handleDeadAgent(agentId: string): Promise<void> {
    const state = this.states.get(agentId);
    if (!state) return;

    if (state.restartCount >= AGENT_RESTART_MAX) {
      logger.error(
        { agentId, restartCount: state.restartCount },
        'Agent exceeded max restarts — giving up',
      );
      state.status = 'dead';
      return;
    }

    state.status = 'restarting';
    const delay = AGENT_RESTART_DELAY_MS * Math.pow(2, state.restartCount); // exponential backoff
    state.restartCount++;

    logger.warn(
      { agentId, restartCount: state.restartCount, delayMs: delay },
      'Restarting dead agent',
    );

    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    await this.restartAgent(agentId);
  }

  async restartAgent(agentId: string): Promise<void> {
    const state = this.states.get(agentId);
    if (!state) return;

    const { agent, restartCount } = state;

    // Reset state (keep restartCount)
    this.states.set(agentId, {
      agentId,
      agent,
      status: 'starting',
      restartCount,
    });

    await this.startAgent(agent);
  }

  private subscribeHeartbeats(): void {
    const sub = this.nc.subscribe('health.>');

    void (async () => {
      for await (const msg of sub) {
        try {
          const payload = JSON.parse(codec.decode(msg.data)) as HeartbeatPayload;
          const state = this.states.get(payload.agentId);
          if (state) {
            state.lastHeartbeat = new Date(payload.ts);
            state.busy = payload.busy ?? false;
            state.task = payload.task ?? '';
            logger.debug({ agentId: payload.agentId, busy: state.busy }, 'Heartbeat received');
          }
        } catch {
          // ignore malformed heartbeats
        }
      }
    })();

    logger.debug('Subscribed to health.> heartbeats');
  }

  private async imageExists(imageName: string): Promise<boolean> {
    try {
      await this.docker.getImage(imageName).inspect();
      return true;
    } catch {
      return false;
    }
  }

  private async removeContainerIfExists(containerName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();

      if (info.State.Running) {
        await container.stop({ t: 30 });
      }
      await container.remove({ force: true });
      logger.debug({ containerName }, 'Removed stale container');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 = container doesn't exist — that's fine
      if (!msg.includes('404') && !msg.includes('no such container')) {
        logger.warn({ err, containerName }, 'Unexpected error removing container');
      }
    }
  }

  /**
   * Read observability config and return env vars for agent containers.
   */
  private async getObservabilityEnvVars(): Promise<string[]> {
    if (!this.configService) return [];
    try {
      const config = await this.configService.load();
      const obs = (config as unknown as Record<string, unknown>)?.observability as ObservabilityConfig | undefined;
      if (!obs || obs.level === 'none') return [];

      const vars: string[] = [`OBSERVABILITY_LEVEL=${obs.level}`];

      if (obs.level === 'full') {
        let otlpEndpoint = obs.endpoints?.otlp ?? 'http://tempo:4318';

        if (DOCKER_NETWORK === 'host') {
          // Host network: compose service names don't resolve, use localhost
          otlpEndpoint = otlpEndpoint
            .replace('://tempo:', '://localhost:')
            .replace('://loki:', '://localhost:');
        } else {
          // Bridge network: localhost → host.docker.internal
          otlpEndpoint = otlpEndpoint
            .replace('localhost', 'host.docker.internal')
            .replace('127.0.0.1', 'host.docker.internal');
        }

        vars.push(`OTEL_EXPORTER_OTLP_ENDPOINT=${otlpEndpoint}`);
      }

      return vars;
    } catch {
      return [];
    }
  }

  /**
   * When DOCKER_NETWORK=host, the container can reach NATS on localhost.
   * Otherwise, use host.docker.internal (works on Docker Desktop / bridge networks).
   */
  private resolveNatsUrl(): string {
    if (DOCKER_NETWORK === 'host') {
      return NATS_URL;
    }
    // Replace localhost / 127.0.0.1 with host.docker.internal for bridge networks
    return NATS_URL.replace('localhost', 'host.docker.internal').replace(
      '127.0.0.1',
      'host.docker.internal',
    );
  }
}
