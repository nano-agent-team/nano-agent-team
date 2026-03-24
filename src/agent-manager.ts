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
import type { NatsConnection, ConsumerMessages } from 'nats';
import { AckPolicy, DeliverPolicy } from 'nats';

import {
  AGENT_IMAGE,
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  AGENT_RESTART_MAX,
  AGENT_RESTART_DELAY_MS,
  API_PORT,
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
import type { AlarmClock } from './alarm-clock.js';
import { emitActivity } from './activity-emitter.js';

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
  ticketId?: string;
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
  ticketId?: string;
}

interface AgentEnvAndBinds {
  env: string[];
  binds: string[];
  image: string;
}

/** Tracks the NATS consumer loop for an ephemeral (workspace_source: 'ticket') agent */
interface EphemeralAgentLoop {
  agent: LoadedAgent;
  /** Call to abort the consumer loop */
  stop: () => void;
  /** Resolves when the loop has fully exited */
  done: Promise<void>;
  /** JetStream consumer name */
  consumerName: string;
}

interface WorkspaceInfo {
  workspaceId: string;
  path: string;
  repoType: string;
  branch: string;
  ownerId: string;
  status: string;
}

// ─── AgentManager ────────────────────────────────────────────────────────────

export class AgentManager {
  private states = new Map<string, AgentState>();
  private ephemeralLoops = new Map<string, EphemeralAgentLoop>();
  private docker: Dockerode;
  private healthTimer?: NodeJS.Timeout;
  private proxyHost: string | null = null;
  private dispatcher: WorkflowDispatcher;
  private alarmClock?: AlarmClock;

  /** When true, ephemeral consumer loops stop pulling new messages (existing containers finish) */
  private ephemeralFrozen = false;
  /** Tracks running ephemeral containers by containerName → ticketId */
  private runningEphemeralContainers = new Map<string, string>();

  constructor(
    private readonly nc: NatsConnection,
    private readonly configService?: ConfigService,
    alarmClock?: AlarmClock,
  ) {
    // Default: connects via /var/run/docker.sock on Linux
    this.docker = new Dockerode();
    this.dispatcher = new WorkflowDispatcher(nc, () => this.getInstanceHeartbeats());
    this.alarmClock = alarmClock;
  }

  /** Returns true when credentials.json exists — agents use proxy instead of direct token */
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
      const vars = [`ANTHROPIC_BASE_URL=http://${proxyHost}:8082`];
      // SDK requires CLAUDE_CODE_OAUTH_TOKEN to pass its internal login check.
      // The actual API auth is handled by the proxy — this token is just a gate-pass.
      // Read current token from credentials.json so SDK doesn't refuse to start.
      const credPath = path.join(DATA_DIR, 'credentials.json');
      try {
        const creds = JSON.parse(fs.readFileSync(credPath, 'utf8')) as { oauth_token?: string };
        if (creds.oauth_token) vars.push(`CLAUDE_CODE_OAUTH_TOKEN=${creds.oauth_token}`);
      } catch { /* ignore */ }
      return vars;
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
      claude: 'claude-sonnet-4-6',
      codex: 'o4-mini',
      gemini: 'gemini-2.0-flash',
    };
    return { provider, model: modelMap['default'] ?? providerDefaults[provider] ?? 'claude-sonnet-4-6', modelExplicit: false };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async startAll(agents: LoadedAgent[]): Promise<void> {
    for (const agent of agents) {
      await this.startAgent(agent);
    }
  }

  async startAgent(agent: LoadedAgent): Promise<void> {
    const id = getInstanceId(agent);

    // ── Ephemeral agent: workspace_source: 'ticket' ──────────────────────────
    // Do NOT start a container at boot. Instead, register a NATS consumer loop
    // in the control plane that intercepts messages, resolves the workspace,
    // and spins up an ephemeral container per task.
    if (agent.manifest.workspace_source === 'ticket') {
      await this.startEphemeralConsumer(agent, id);
      return;
    }

    // ── Persistent agent (normal flow) ───────────────────────────────────────
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

      emitActivity(this.nc, {
        agent: id, type: 'action',
        summary: `Container started: ${containerName}`, timestamp: Date.now(),
      });

      // Bootstrap alarm for deterministic agents
      if (agent.manifest.kind === 'deterministic' && this.alarmClock) {
        this.alarmClock.cancelForAgent(id);
        this.alarmClock.set(id, 10, { type: 'poll' });
        logger.info({ agentId: id }, 'Bootstrap alarm set for deterministic agent');
      }

      // NOTE: No recurring alarms for individual agents. A dedicated lightweight
      // wakeup agent (haiku) handles periodic state checks and sends targeted
      // kicks only to agents that have work. Avoids burning tokens on idle agents.
    } catch (err) {
      logger.error({ err, id }, 'Failed to start agent container');
      const state = this.states.get(id);
      if (state) state.status = 'dead';
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    // Stop ephemeral consumer loop if this is an ephemeral agent
    const ephemeralLoop = this.ephemeralLoops.get(agentId);
    if (ephemeralLoop) {
      ephemeralLoop.stop();
      await ephemeralLoop.done;
      this.ephemeralLoops.delete(agentId);
      const state = this.states.get(agentId);
      if (state) state.status = 'dead';
      logger.info({ agentId }, 'Ephemeral agent consumer stopped');
      return;
    }

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
      emitActivity(this.nc, {
        agent: agentId, type: 'action',
        summary: `Container stopped: ${containerName}`, timestamp: Date.now(),
      });
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
    ticketId?: string;
    rollingOver?: boolean;
    ephemeral?: boolean;
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
      ticketId: s.ticketId,
      rollingOver: s.status === 'rolling-over' || !!s.pendingContainerId,
      ephemeral: s.agent.manifest.workspace_source === 'ticket',
    }));
  }

  /** Freeze ephemeral agents — consumer loops stop pulling new messages. Running containers finish normally. */
  freezeEphemeral(): void {
    this.ephemeralFrozen = true;
    logger.info('Ephemeral agents frozen — no new containers will be started');
  }

  /** Unfreeze ephemeral agents — consumer loops resume pulling. */
  unfreezeEphemeral(): void {
    this.ephemeralFrozen = false;
    logger.info('Ephemeral agents unfrozen — accepting new tasks');
  }

  /** Returns status of ephemeral containers: frozen flag + list of running containers. */
  getEphemeralStatus(): { frozen: boolean; running: { containerName: string; ticketId: string }[] } {
    return {
      frozen: this.ephemeralFrozen,
      running: [...this.runningEphemeralContainers.entries()].map(([containerName, ticketId]) => ({ containerName, ticketId })),
    };
  }

  async stopAll(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }

    // Stop ephemeral consumer loops
    for (const [, loop] of this.ephemeralLoops) loop.stop();
    await Promise.allSettled([...this.ephemeralLoops.values()].map(l => l.done));
    this.ephemeralLoops.clear();

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

  // ── Ephemeral agent support (workspace_source: 'ticket') ──────────────────

  /**
   * Start a control-plane NATS consumer for an ephemeral agent.
   * Instead of starting a persistent container, this sets up a pull loop
   * that intercepts task messages and spawns a fresh container per message.
   */
  private async startEphemeralConsumer(agent: LoadedAgent, agentId: string): Promise<void> {
    if (this.ephemeralLoops.has(agentId)) {
      logger.warn({ agentId }, 'Ephemeral consumer already running — skipping');
      return;
    }

    // Register the agent in states map as 'running' (ephemeral — no container yet)
    this.states.set(agentId, {
      agentId,
      agent,
      status: 'running',
      restartCount: 0,
      startedAt: new Date(),
    });

    const filterSubjects = resolveTopicsForAgent(agent.manifest, agent.binding, agentId);
    const consumerName = agent.consumerName ?? agentId;

    // Ensure durable consumer exists in JetStream
    const jsm = await this.nc.jetstreamManager();
    try {
      await jsm.consumers.info('AGENTS', consumerName);
    } catch {
      const consumerConfig: Record<string, unknown> = {
        durable_name: consumerName,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
        // Long ack_wait: ephemeral containers may take a while to process
        ack_wait: 600_000_000_000, // 10 min in nanoseconds
      };
      if (filterSubjects.length === 1) {
        consumerConfig.filter_subject = filterSubjects[0];
      } else {
        consumerConfig.filter_subjects = filterSubjects;
      }
      await jsm.consumers.add('AGENTS', consumerConfig as Parameters<typeof jsm.consumers.add>[1]);
    }

    const js = this.nc.jetstream();
    const consumer = await js.consumers.get('AGENTS', consumerName);

    const signal = { aborted: false };
    const messagesRef: { current: ConsumerMessages | null } = { current: null };

    logger.info(
      { agentId, filterSubjects, consumerName },
      'Ephemeral agent: started NATS consumer loop (no persistent container)',
    );

    const done = this.runEphemeralLoop(consumer, agent, agentId, signal, messagesRef);

    this.ephemeralLoops.set(agentId, {
      agent,
      stop: () => {
        signal.aborted = true;
        messagesRef.current?.close();
      },
      done,
      consumerName,
    });
  }

  /**
   * Run the ephemeral consumer loop with exponential backoff on errors.
   */
  private async runEphemeralLoop(
    consumer: Awaited<ReturnType<ReturnType<NatsConnection['jetstream']>['consumers']['get']>>,
    agent: LoadedAgent,
    agentId: string,
    signal: { aborted: boolean },
    messagesRef: { current: ConsumerMessages | null },
  ): Promise<void> {
    let delay = 1000;
    while (!this.nc.isClosed() && !signal.aborted) {
      try {
        await this.ephemeralPullLoop(consumer, agent, agentId, signal, messagesRef);
        break;
      } catch (err) {
        if (signal.aborted) break;
        logger.error({ err, agentId, retryInMs: delay }, 'Ephemeral consumer loop crashed — restarting');
        await new Promise(resolve => setTimeout(resolve, delay));
        if (signal.aborted) break;
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  /**
   * Pull messages from the ephemeral agent's JetStream consumer.
   * For each message, resolve workspace → create container → wait for exit → cleanup.
   */
  private async ephemeralPullLoop(
    consumer: Awaited<ReturnType<ReturnType<NatsConnection['jetstream']>['consumers']['get']>>,
    agent: LoadedAgent,
    agentId: string,
    signal: { aborted: boolean },
    messagesRef: { current: ConsumerMessages | null },
  ): Promise<void> {
    const messages = await consumer.consume({ max_messages: 1 });
    messagesRef.current = messages;

    for await (const msg of messages) {
      if (signal.aborted) {
        msg.nak();
        break;
      }

      // Freeze check: if frozen, nak the message so it's redelivered later
      if (this.ephemeralFrozen) {
        logger.info({ agentId }, 'Ephemeral agents frozen — nacking message for later redelivery');
        msg.nak();
        // Wait a bit before pulling next (avoid tight nak loop)
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      let taskId: string | undefined;
      try {
        const payload = JSON.parse(codec.decode(msg.data)) as Record<string, unknown>;
        taskId = (payload.ticket_id ?? payload.ticketId) as string | undefined;
      } catch {
        logger.warn({ agentId }, 'Ephemeral agent: cannot parse message payload — nacking');
        msg.nak();
        continue;
      }

      if (!taskId) {
        logger.warn({ agentId }, 'Ephemeral agent: message has no ticket_id — nacking');
        msg.nak();
        continue;
      }

      const containerName = `nano-agent-${agentId}-${taskId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
      this.runningEphemeralContainers.set(containerName, taskId);

      emitActivity(this.nc, {
        agent: agentId, type: 'thinking',
        summary: `Processing message on ${msg.subject}`, timestamp: Date.now(),
      });

      try {
        await this.runEphemeralContainer(agent, agentId, taskId, msg.data, msg.headers);
        msg.ack();
        logger.info({ agentId, taskId }, 'Ephemeral container completed successfully');
      } catch (err) {
        logger.error({ err, agentId, taskId }, 'Ephemeral container failed');
        msg.nak();
      } finally {
        this.runningEphemeralContainers.delete(containerName);
      }
    }
  }

  /**
   * Resolve workspace for a ticket, spin up an ephemeral container, wait for it to exit, clean up.
   */
  private async runEphemeralContainer(
    agent: LoadedAgent,
    agentId: string,
    ticketId: string,
    messageData: Uint8Array,
    messageHeaders?: import('nats').MsgHdrs,
  ): Promise<void> {
    // 1. Resolve workspace path from workspace provider (create-if-not-exists)
    const apiPort = API_PORT;
    const workspaceUrl = `http://localhost:${apiPort}/internal/workspaces/by-owner/${encodeURIComponent(ticketId)}`;

    let resp = await fetch(workspaceUrl);
    if (!resp.ok) {
      // Workspace doesn't exist yet — create it automatically (GH-103: scrum-master dispatches without pre-creating workspaces)
      logger.info({ ticketId, agentId }, 'Workspace not found — creating automatically');
      const defaultRepoType = process.env.DEFAULT_WORKSPACE_REPO ?? 'nano-agent-team';
      const createResp = await fetch(`http://localhost:${apiPort}/internal/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoType: defaultRepoType, ownerId: ticketId }),
      });
      if (!createResp.ok) {
        const detail = await createResp.text().catch(() => '');
        throw new Error(`Failed to create workspace for ticket ${ticketId}: ${createResp.status} ${detail}`);
      }
      // Re-fetch by owner to get the full workspace info
      resp = await fetch(workspaceUrl);
      if (!resp.ok) {
        throw new Error(`Workspace still not found after creation for ticket ${ticketId}`);
      }
    }
    const workspace = await resp.json() as WorkspaceInfo;

    // HOST_DATA_DIR resolution: workspace.path is relative to the control plane container.
    // For Docker bind mounts, we need the host path.
    const hostDataDir = process.env.HOST_DATA_DIR ?? path.dirname(DB_PATH);
    // workspace.path is absolute (e.g. /data/workspaces/active/ws-xxx)
    // We need to translate it: replace DATA_DIR prefix with hostDataDir
    const hostWorkspacePath = workspace.path.replace(DATA_DIR, hostDataDir);

    // 2. Build env and binds (same as persistent agent)
    const { env, binds, image } = await this.buildAgentEnvAndBinds(agent, agentId, [
      // Pass the task message as env var so agent-runner processes it immediately
      `EPHEMERAL_TASK_MESSAGE=${Buffer.from(messageData).toString('base64')}`,
      `EPHEMERAL_TICKET_ID=${ticketId}`,
      // Force stateless session for ephemeral containers
      'SESSION_TYPE=stateless',
    ]);

    // 3. Add workspace bind mount
    binds.push(`${hostWorkspacePath}:/workspace/repo:rw`);

    // 4. Create and start ephemeral container
    const containerName = `nano-agent-${agentId}-${ticketId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
    await this.removeContainerIfExists(containerName);

    logger.info({ agentId, ticketId, containerName, workspacePath: hostWorkspacePath }, 'Starting ephemeral container');

    const container = await this.docker.createContainer({
      Image: image,
      name: containerName,
      Env: env,
      HostConfig: {
        Binds: binds,
        NetworkMode: DOCKER_NETWORK,
        RestartPolicy: { Name: 'no' },
      },
    });

    await container.start();

    emitActivity(this.nc, {
      agent: agentId, type: 'action',
      summary: `Container started: ${containerName}`, timestamp: Date.now(),
    });

    // 5. Wait for container to exit (no timeout — watchdog agent will handle stuck containers in the future)
    await container.wait().catch(() => {});
    const exited = true;

    // 6. Check exit code
    try {
      const info = await container.inspect() as { State: { ExitCode: number } };
      if (info.State.ExitCode !== 0) {
        logger.warn({ agentId, ticketId, exitCode: info.State.ExitCode }, 'Ephemeral container exited with error');
      }
    } catch {
      // Container may already be gone
    }

    // Always remove ephemeral containers after they're done
    await container.remove({ force: true }).catch(() => {});
    logger.debug({ agentId, ticketId, containerName }, 'Ephemeral container cleaned up');
    emitActivity(this.nc, {
      agent: agentId, type: 'action',
      summary: `Container stopped: ${containerName}`, timestamp: Date.now(),
    });
  }

  // NOTE: runSoulEphemeralContainer() removed — conscience migrated to persistent (2026-03-24)

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

    const isDeterministic = agent.manifest.kind === 'deterministic';

    const env = [
      `NATS_URL=${this.resolveNatsUrl()}`,
      `AGENT_ID=${agentId}`,
      `CONSUMER_NAME=${agent.consumerName ?? agentId}`,
      `SUBSCRIBE_TOPICS=${(Array.isArray(vaultConfig.subscribe_topics) && vaultConfig.subscribe_topics.length > 0 ? vaultConfig.subscribe_topics : resolveTopicsForAgent(agent.manifest, agent.binding, agentId)).join(',')}`,
      `PROVIDER=${isDeterministic ? 'none' : providerName}`,
      `MODEL=${model}`,
      // MCP Gateway — HTTP MCP server in nate, accessible from DinD via host.docker.internal
      `MCP_GATEWAY_URL=http://${this.resolveMcpGatewayHost()}:${MCP_GATEWAY_PORT}/mcp`,
      // Tickets MCP server DB path inside container
      `DB_PATH=/workspace/db/${path.basename(DB_PATH)}`,
      `LOG_LEVEL=info`,
      // Pass GitHub token if available (from team config or env vars, for gh CLI and git push)
      ...(githubToken ? [`GH_TOKEN=${githubToken}`] : []),
      // Inject allowed tools from manifest (e.g. ["Skill"] for superpowers skills) — LLM agents only
      ...(!isDeterministic && agent.manifest.allowedTools?.length ? [`AGENT_ALLOWED_TOOLS=${agent.manifest.allowedTools.join(',')}`] : []),
      // Enable context-mode MCP server for code search (opt-in via manifest) — LLM agents only
      ...(!isDeterministic && agent.manifest.context_mode ? ['CONTEXT_MODE=true'] : []),
      // Preload specific skills into systemPrompt (injected at startup) — LLM agents only
      ...(!isDeterministic && agent.manifest.preload_skills?.length ? [`PRELOAD_SKILLS=${agent.manifest.preload_skills.join(',')}`] : []),
      // Agent teams: enable native Claude Code multi-agent coordination (unconditional)
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
      // Pass repo URL from config (set during team install)
      ...(repoUrl ? [`REPO_URL=${repoUrl}`] : []),
      // Deterministic agent: inject handler module name, skip all LLM-specific vars
      ...(isDeterministic && agent.manifest.handler ? [`HANDLER=${agent.manifest.handler}`] : []),
      // LLM-specific env vars (skipped for deterministic agents)
      ...(!isDeterministic ? [
        `MODEL_EXPLICIT=${modelExplicit}`,
        `SESSION_TYPE=${agent.manifest.session_type ?? 'stateless'}`,
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
        // Pass CLAUDE.md content as env var (avoids Docker bind mount path resolution issues)
        ...(claudeMdContent ? [`AGENT_SYSTEM_PROMPT=${claudeMdContent}`] : []),
        // Inject allowed tools from manifest (e.g. ["Skill"] for superpowers skills)
        ...(agent.manifest.allowedTools?.length ? [`AGENT_ALLOWED_TOOLS=${agent.manifest.allowedTools.join(',')}`] : []),
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
      ] : []),
      // AlarmClock polling interval for persistent agents (consciousness, strategist)
      `AGENT_POLL_INTERVAL_SECONDS=${process.env.AGENT_POLL_INTERVAL_SECONDS ?? '300'}`,
      // Observability: propagate OTel config to agent containers
      ...await this.getObservabilityEnvVars(),
      // Caller-supplied extras (e.g. WAIT_FOR_START_SIGNAL=true for rollover)
      ...(extraEnv ?? []),
    ];

    // Volume: agent dir → /workspace/agent (read-only)
    // Translate container path to host path (agent.dir is relative to DATA_DIR inside container)
    const hostAgentDir = agent.dir.replace(DATA_DIR, hostDataDir);
    const binds = [`${hostAgentDir}:/workspace/agent:ro`];

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
    // Claude Code credentials → /home/agent/.claude (read-write for session cache)
    // Claude Code 2.x also needs ~/.claude.json (OAuth token file)
    const claudeDir = path.join(process.env.HOME ?? '/root', '.claude');
    const hostClaudeDir = process.env.HOST_CLAUDE_DIR ?? claudeDir;

    if ((providerName === 'claude' || providerName === 'auto' || !providerName) && !this.isProxyMode()) {
      // Direct auth mode: mount entire .claude dir (rw) for credentials + session cache
      if (fs.existsSync(claudeDir)) {
        binds.push(`${hostClaudeDir}:/home/agent/.claude:rw`);
        logger.debug({ agentId, hostClaudeDir }, 'Mounting .claude dir (rw)');
      }
      const claudeJson = path.join(process.env.HOME ?? '/root', '.claude.json');
      const hostClaudeJson = process.env.HOST_CLAUDE_JSON ?? claudeJson;
      if (fs.existsSync(claudeJson)) {
        binds.push(`${hostClaudeJson}:/home/agent/.claude.json:rw`);
        logger.debug({ agentId, hostClaudeJson }, 'Mounting .claude.json (rw)');
      }
    } else {
      // Proxy mode: mount only plugins + settings (read-only) for superpowers/skills.
      // Don't mount entire .claude dir — that would shadow baked-in skills from the image.
      const pluginsDir = path.join(claudeDir, 'plugins');
      if (fs.existsSync(pluginsDir)) {
        binds.push(`${hostClaudeDir}/plugins:/home/agent/.claude/plugins:ro`);
        logger.debug({ agentId }, 'Mounting .claude/plugins (ro) for superpowers');
      }
      const settingsPath = path.join(claudeDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        binds.push(`${hostClaudeDir}/settings.json:/home/agent/.claude/settings.json:ro`);
        logger.debug({ agentId }, 'Mounting .claude/settings.json (ro) for plugin config');
      }
    }

    // Codex CLI credentials → /home/agent/.codex (read-write so Codex CLI can refresh tokens)
    // HOST_CODEX_DIR = host path (for Docker bind source)
    // container path /home/agent/.codex = where we check existence
    if (providerName === 'codex') {
      const containerCodexDir = path.join(process.env.HOME ?? '/root', '.codex');
      const hostCodexDir = process.env.HOST_CODEX_DIR ?? containerCodexDir;
      if (fs.existsSync(containerCodexDir)) {
        binds.push(`${hostCodexDir}:/home/agent/.codex:rw`);
        logger.debug({ agentId, hostCodexDir }, 'Mounting .codex dir (rw)');
      }
    }

    // Volume: SSH keys → /home/agent/.ssh (optional, for agents needing git SSH push)
    if (agent.manifest.ssh_mount) {
      const sshDir = path.join(process.env.HOME ?? '/root', '.ssh');
      if (fs.existsSync(sshDir)) {
        binds.push(`${sshDir}:/home/agent/.ssh:ro`);
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

    // Volume: instance Obsidian vault → /obsidian (shared knowledge base for all agents)
    const obsidianDir = path.join(hostDataDir, 'obsidian');
    fs.mkdirSync(obsidianDir, { recursive: true });
    binds.push(`${obsidianDir}:/obsidian:rw`);

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
            const wasBusy = state.busy;
            state.lastHeartbeat = new Date(payload.ts);
            state.busy = payload.busy ?? false;
            state.task = payload.task ?? '';
            state.ticketId = (payload as any).ticketId ?? undefined;
            logger.debug({ agentId: payload.agentId, busy: state.busy }, 'Heartbeat received');

            // Emit activity events for persistent agents based on busy state transitions
            if (state.busy && !wasBusy) {
              emitActivity(this.nc, {
                agent: payload.agentId, type: 'thinking',
                summary: state.task || 'Processing...', timestamp: Date.now(),
              });
            }
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
