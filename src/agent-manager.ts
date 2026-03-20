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
  MCP_GATEWAY_PORT,
} from './config.js';
import { logger } from './logger.js';
import type { LoadedAgent, DispatchConfig } from './agent-registry.js';
import { resolveTopicsForAgent, getInstanceId } from './agent-registry.js';
import type { ConfigService, NanoConfig } from './config-service.js';
import { codec } from './nats-client.js';
import { WorkflowDispatcher } from './workflow-dispatcher.js';

interface ObservabilityConfig {
  level?: string;
  provider?: string;
  endpoints?: { otlp?: string };
}

// ─── Types ───────────────────────────────────────────────────────────────────

type AgentStatus = 'starting' | 'running' | 'dead' | 'restarting' | 'rolling-over';

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
  /** Container being rolled in (zero-downtime deployment) */
  pendingContainerId?: string;
  rolloverTimeout?: NodeJS.Timeout;
  /** Marked for removal on next reload; health monitor skips these entries */
  pendingRemoval?: boolean;
}

interface HeartbeatPayload {
  agentId: string;
  ts: number;
  busy?: boolean;
  task?: string;
}

interface AgentEnvAndBinds {
  env: string[];
  binds: string[];
  image: string;
}

// ─── AgentManager ────────────────────────────────────────────────────────────

export class AgentManager {
  private states = new Map<string, AgentState>();
  private docker: Dockerode;
  private healthTimer?: NodeJS.Timeout;
  private proxyHost: string | null = null;
  private dispatcher: WorkflowDispatcher;

  constructor(
    private readonly nc: NatsConnection,
    private readonly configService?: ConfigService,
  ) {
    // Default: connects via /var/run/docker.sock on Linux
    this.docker = new Dockerode();
    this.dispatcher = new WorkflowDispatcher(nc, () => this.getInstanceHeartbeats());
  }

  /** Returns true when USE_CREDENTIAL_PROXY=true — agents use proxy instead of direct token */
  private isProxyMode(): boolean {
    return process.env.USE_CREDENTIAL_PROXY === 'true';
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
    const id = getInstanceId(agent);
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
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

      const { env, binds, image } = await this.buildAgentEnvAndBinds(agent, id);

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
   * Mark an agent for removal from the in-memory state map.
   * Uses a flag instead of immediate delete to avoid races with the health monitor loop.
   * The state is overwritten by the next startAgent call for the same agentId.
   */
  removeFromStates(agentId: string): void {
    const state = this.states.get(agentId);
    if (state) state.pendingRemoval = true;
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
    rollingOver?: boolean;
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
      rollingOver: s.status === 'rolling-over' || !!s.pendingContainerId,
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
      if (state.pendingRemoval) continue;
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

  /**
   * Zero-downtime agent rollover (Phase 5).
   *
   * Sequence:
   * 1. Start new container with WAIT_FOR_START_SIGNAL=true, name nano-agent-{id}-next
   * 2. Wait for agent.{id}.ready signal (max 30s)
   * 3. Send drain signal to old container: agent.{id}.drain
   * 4. Wait for old container to exit (max 60s drain timeout)
   * 5. Signal new container to start consuming: agent.{id}.start-consuming
   * 6. Rename new container → nano-agent-{id} and update internal state
   */
  async rolloverAgent(agentId: string, newAgent?: LoadedAgent): Promise<void> {
    const state = this.states.get(agentId);
    if (!state) {
      logger.warn({ agentId }, 'rolloverAgent: agent not found');
      return;
    }
    if (state.pendingContainerId) {
      logger.warn({ agentId }, 'rolloverAgent: rollover already in progress');
      return;
    }

    const agent = newAgent ?? state.agent;
    const nextContainerName = `nano-agent-${agentId}-next`;
    const READY_TIMEOUT_MS = 30_000;
    const DRAIN_TIMEOUT_MS = 60_000;

    logger.info({ agentId }, 'Starting zero-downtime rollover');
    state.status = 'rolling-over';

    try {
      // 1. Start new container in wait-for-signal mode
      await this.removeContainerIfExists(nextContainerName);

      const { env, binds, image } = await this.buildAgentEnvAndBinds(agent, agentId, ['WAIT_FOR_START_SIGNAL=true']);

      const nextContainer = await this.docker.createContainer({
        Image: image,
        name: nextContainerName,
        Env: env,
        HostConfig: {
          Binds: binds,
          NetworkMode: DOCKER_NETWORK,
          RestartPolicy: { Name: 'no' },
        },
      });

      await nextContainer.start();
      state.pendingContainerId = nextContainer.id;
      logger.info({ agentId, containerId: nextContainer.id.slice(0, 12) }, 'Next container started (waiting for ready)');

      // 2. Wait for agent.{id}.ready signal
      const readyReceived = await Promise.race([
        new Promise<boolean>((resolve) => {
          const sub = this.nc.subscribe(`agent.${agentId}.ready`, { max: 1 });
          void (async () => {
            for await (const _msg of sub) { resolve(true); return; }
          })();
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READY_TIMEOUT_MS)),
      ]);

      if (!readyReceived) {
        logger.warn({ agentId }, 'Next container did not signal ready in time — aborting rollover');
        await this.docker.getContainer(nextContainer.id).remove({ force: true }).catch(() => {});
        state.pendingContainerId = undefined;
        state.status = 'running';
        return;
      }

      logger.info({ agentId }, 'Next container ready — draining old container');

      // 3. Send drain signal to old container
      this.nc.publish(`agent.${agentId}.drain`, codec.encode(JSON.stringify({ agentId, ts: Date.now() })));

      // 4. Wait for old container to exit (or timeout)
      const oldExited = state.containerId
        ? await Promise.race([
          new Promise<boolean>((resolve) => {
            const poll = setInterval(async () => {
              try {
                const info = await this.docker.getContainer(state.containerId!).inspect() as { State: { Running: boolean } };
                if (!info.State.Running) { clearInterval(poll); resolve(true); }
              } catch { clearInterval(poll); resolve(true); }
            }, 2_000);
          }),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
        ])
        : true;

      if (!oldExited) {
        logger.warn({ agentId }, 'Old container drain timeout — force removing');
        if (state.containerId) {
          await this.docker.getContainer(state.containerId).remove({ force: true }).catch(() => {});
        }
      } else {
        logger.info({ agentId }, 'Old container drained and exited');
        if (state.containerId) {
          await this.docker.getContainer(state.containerId).remove({ force: true }).catch(() => {});
        }
      }

      // 5. Signal new container to start consuming
      this.nc.publish(`agent.${agentId}.start-consuming`, codec.encode(JSON.stringify({ agentId, ts: Date.now() })));

      // 6. Update internal state
      state.containerId = nextContainer.id;
      state.pendingContainerId = undefined;
      state.agent = agent;
      state.status = 'running';
      state.startedAt = new Date();

      logger.info({ agentId, containerId: nextContainer.id.slice(0, 12) }, 'Rollover complete — new container is active');

    } catch (err) {
      logger.error({ err, agentId }, 'Rollover failed');
      state.pendingContainerId = undefined;
      state.status = 'running'; // revert to running so health monitoring continues
    }
  }

  /**
   * Build the full env, binds, and image for an agent container.
   * Shared by startAgent() and rolloverAgent() to eliminate duplication.
   * @param agent     The loaded agent definition
   * @param agentId   The agent instance ID
   * @param extraEnv  Additional env vars appended at the end (e.g. ['WAIT_FOR_START_SIGNAL=true'])
   */
  private async buildAgentEnvAndBinds(agent: LoadedAgent, agentId: string, extraEnv?: string[]): Promise<AgentEnvAndBinds> {
    // HOST_DATA_DIR lets Docker daemon (on host) resolve the correct bind path
    const hostDataDir = process.env.HOST_DATA_DIR ?? path.dirname(DB_PATH);

    // Vault config override (model, subscribe_topics)
    const vaultId = agent.vaultId ?? agentId;
    const vaultConfigPath = path.join(DATA_DIR, 'vault', 'agents', `${vaultId}.json`);
    let vaultConfig: { model?: string; subscribe_topics?: string[] } = {};
    if (fs.existsSync(vaultConfigPath)) {
      try { vaultConfig = JSON.parse(fs.readFileSync(vaultConfigPath, 'utf8')); } catch { /* ignore */ }
    }

    // Config service
    let config: NanoConfig | null = null;
    if (this.configService) {
      config = await this.configService.load();
    }

    // Resolve provider and model for this agent
    const { provider: providerName, model: baseModel, modelExplicit } = this.resolveAgentProvider(agent, config ?? {});
    const model = vaultConfig.model ?? baseModel;
    if (vaultConfig.model) {
      logger.info({ agentId, vaultModel: vaultConfig.model, baseModel }, 'Model overridden by vault config');
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
                .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
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
    const customInstructionsPath = path.join(DATA_DIR, 'vault', 'agents', `${vaultId}.md`);
    if (fs.existsSync(customInstructionsPath)) {
      const customContent = fs.readFileSync(customInstructionsPath, 'utf8').trim();
      if (customContent) {
        claudeMdContent += `\n\n## Custom instructions\n\n${customContent}`;
      }
    }

    const env = [
      `NATS_URL=${this.resolveNatsUrl()}`,
      `AGENT_ID=${agentId}`,
      `CONSUMER_NAME=${agent.consumerName ?? agentId}`,
      `SUBSCRIBE_TOPICS=${(Array.isArray(vaultConfig.subscribe_topics) && vaultConfig.subscribe_topics.length > 0 ? vaultConfig.subscribe_topics : resolveTopicsForAgent(agent.manifest, agent.binding, agentId)).join(',')}`,
      `PROVIDER=${providerName}`,
      `MODEL=${model}`,
      `MODEL_EXPLICIT=${modelExplicit}`,
      `SESSION_TYPE=${agent.manifest.session_type ?? 'stateless'}`,
      `LOG_LEVEL=info`,
      // MCP Gateway — HTTP MCP server in nate, accessible from DinD via host.docker.internal
      `MCP_GATEWAY_URL=http://${this.resolveMcpGatewayHost()}:${MCP_GATEWAY_PORT}/mcp`,
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
      // Inject MCP servers from mcp_config manifest field
      ...(() => {
        if (!agent.manifest.mcp_config) return [];
        try {
          const raw = fs.readFileSync(agent.manifest.mcp_config, 'utf8');
          const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
          const servers = parsed.mcpServers ?? {};
          // Patch API_PORT and CONTROL_PLANE_URL to match current instance
          const apiPort = process.env.API_PORT ?? '3001';
          const cfg = servers as Record<string, { env?: Record<string, string> }>;
          if (cfg.config?.env) cfg.config.env['API_PORT'] = apiPort;
          if (cfg.management?.env) {
            cfg.management.env['CONTROL_PLANE_URL'] = `http://host.docker.internal:${apiPort}`;
          }
          return [`AGENT_MCP_SERVERS=${JSON.stringify(servers)}`];
        } catch {
          return [];
        }
      })(),
      // Pass GitHub token if available (from team config or env vars, for gh CLI and git push)
      ...(githubToken ? [`GH_TOKEN=${githubToken}`] : []),
      // Pass repo URL from config (set during team install)
      ...(repoUrl ? [`REPO_URL=${repoUrl}`] : []),
      // Observability: propagate OTel config to agent containers
      ...await this.getObservabilityEnvVars(),
      // Caller-supplied extras (e.g. WAIT_FOR_START_SIGNAL=true for rollover)
      ...(extraEnv ?? []),
    ];

    // Volume: agent dir → /workspace/agent (read-only)
    const binds = [`${agent.dir}:/workspace/agent:ro`];

    // Volume: DB dir → /workspace/db (read-write, for MCP tickets server)
    binds.push(`${hostDataDir}:/workspace/db:rw`);

    // Volume: shared vault → /workspace/vault (read-write, all agents)
    const vaultDir = path.join(hostDataDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    binds.push(`${vaultDir}:/workspace/vault:rw`);

    // Volume: per-agent sessions → /workspace/sessions (read-write, Claude SDK storage)
    const sessionDir = path.join(hostDataDir, 'sessions', agentId);
    fs.mkdirSync(sessionDir, { recursive: true });
    binds.push(`${sessionDir}:/workspace/sessions:rw`);

    // Volume: Provider-specific credentials
    // Claude Code credentials → /root/.claude (read-write for session cache)
    // Claude Code 2.x also needs ~/.claude.json (OAuth token file)
    // Skip in proxy mode: agents use ANTHROPIC_BASE_URL instead of direct auth
    if ((providerName === 'claude' || providerName === 'auto' || !providerName) && !this.isProxyMode()) {
      const claudeDir = path.join(process.env.HOME ?? '/root', '.claude');
      const hostClaudeDir = process.env.HOST_CLAUDE_DIR ?? claudeDir;
      if (fs.existsSync(claudeDir)) {
        binds.push(`${hostClaudeDir}:/root/.claude:rw`);
        logger.debug({ agentId, hostClaudeDir }, 'Mounting .claude dir (rw)');
      }
      const claudeJson = path.join(process.env.HOME ?? '/root', '.claude.json');
      const hostClaudeJson = process.env.HOST_CLAUDE_JSON ?? claudeJson;
      if (fs.existsSync(claudeJson)) {
        binds.push(`${hostClaudeJson}:/root/.claude.json:rw`);
        logger.debug({ agentId, hostClaudeJson }, 'Mounting .claude.json (rw)');
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
        logger.debug({ agentId, hostCodexDir }, 'Mounting .codex dir (rw)');
      }
    }

    // Volume: SSH keys → /root/.ssh (optional, for agents needing git SSH push)
    if (agent.manifest.ssh_mount) {
      const sshDir = path.join(process.env.HOME ?? '/root', '.ssh');
      if (fs.existsSync(sshDir)) {
        binds.push(`${sshDir}:/root/.ssh:ro`);
        logger.debug({ agentId, sshDir }, 'Mounting SSH keys');
      } else {
        logger.warn({ agentId, sshDir }, 'ssh_mount=true but ~/.ssh not found on host');
      }
    }

    // Volume: personal workspace → /workspace/personal (optional, for developer-type agents)
    if (agent.manifest.workspace) {
      const wsDir = path.join(hostDataDir, 'workspaces', agentId);
      fs.mkdirSync(wsDir, { recursive: true });
      binds.push(`${wsDir}:/workspace/personal:rw`);
      logger.debug({ agentId, wsDir }, 'Mounting personal workspace');
    }

    // Volume: repo path → /workspace/repo (optional, for git workflow agents)
    if (agent.manifest.repo_path) {
      binds.push(`${agent.manifest.repo_path}:/workspace/repo:rw`);
      logger.debug({ agentId, repo_path: agent.manifest.repo_path }, 'Mounting repo workspace');
    }

    // Volume: project root → /workspace/repo (for self-dev agents that edit the project itself)
    if (agent.manifest.project_workspace && !agent.manifest.repo_path) {
      const projectRoot = path.resolve(hostDataDir, '..', '..');
      binds.push(`${projectRoot}:/workspace/repo:rw`);
      logger.debug({ agentId, projectRoot }, 'Mounting project workspace');
    } else if (agent.manifest.project_workspace && agent.manifest.repo_path) {
      logger.warn({ agentId }, 'project_workspace ignored: repo_path already set for /workspace/repo');
    }

    // Use per-agent image if specified in manifest.
    // Convention: if agents/{id}/Dockerfile exists, image is nano-agent-{id}:latest
    // Otherwise fall back to default AGENT_IMAGE.
    const perAgentImage = `nano-agent-${agentId}:latest`;
    const hasPerAgentImage = await this.imageExists(perAgentImage);
    const image = agent.manifest.image ?? (hasPerAgentImage ? perAgentImage : AGENT_IMAGE);
    logger.debug({ agentId, image }, 'Using container image');

    return { env, binds, image };
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

  /** Returns the hostname agent containers should use to reach nate services (MCP Gateway etc.) */
  private resolveMcpGatewayHost(): string {
    return DOCKER_NETWORK === 'host' ? 'localhost' : 'host.docker.internal';
  }

  /**
   * Returns a map of instanceId → heartbeat data for use by WorkflowDispatcher.
   */
  getInstanceHeartbeats(): Map<string, { busy: boolean; lastSeen: Date }> {
    const result = new Map<string, { busy: boolean; lastSeen: Date }>();
    for (const [instanceId, state] of this.states.entries()) {
      if (state.lastHeartbeat) {
        result.set(instanceId, {
          busy: state.busy ?? false,
          lastSeen: state.lastHeartbeat,
        });
      }
    }
    return result;
  }

  /**
   * Register a dispatch rule for a NATS subject.
   * Delegates to WorkflowDispatcher which manages the pull loop.
   */
  async registerDispatch(subject: string, config: DispatchConfig): Promise<void> {
    await this.dispatcher.register(subject, config);
  }

  /**
   * Register a 1-to-1 entrypoint route: external subject → agent entrypoint subject.
   * Delegates to WorkflowDispatcher.
   */
  async registerEntrypointRoute(from: string, toSubject: string): Promise<void> {
    await this.dispatcher.registerEntrypointRoute(from, toSubject);
  }

  /**
   * Stop and remove a specific entrypoint route loop.
   * Allows re-registration with the same key after this call.
   */
  async unregisterEntrypointRoute(from: string, toSubject: string): Promise<void> {
    await this.dispatcher.unregisterEntrypointRoute(from, toSubject);
  }

  /**
   * Stop and remove a specific dispatch rule loop.
   * Allows re-registration with the same subject after this call.
   */
  async unregisterDispatch(subject: string): Promise<void> {
    await this.dispatcher.unregisterDispatch(subject);
  }

  /**
   * Stop all dispatcher loops cleanly (routes + dispatches).
   */
  async stopAllDispatches(): Promise<void> {
    await this.dispatcher.stopAll();
  }

  /**
   * Returns the keys of all currently active dispatcher loops.
   */
  get activeDispatcherRoutes(): string[] {
    return this.dispatcher.activeRouteKeys;
  }
}
