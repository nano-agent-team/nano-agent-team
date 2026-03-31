/**
 * nano-agent-team — startup entry point
 *
 * Startup sequence:
 * 1. Detect setup mode (first-run / setup-incomplete / ready)
 * 2. Connect to NATS JetStream
 * 3. Ensure AGENTS stream
 * 4. Bootstrap base agents from hub (consciousness, conscience, strategist, foreman)
 * 4a. Setup mode: start base agents, wait for provider config
 * 4b. Ready mode: load all agents from /data/agents + features from config
 * 5. Start API server
 *
 * Base agents (consciousness layer + foreman) are always installed from hub on first startup.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { DATA_DIR, NATS_URL, MCP_GATEWAY_PORT } from './config.js';
import { logger } from './logger.js';
import { startCredentialProxy, startAutoRefresh, stopAutoRefresh } from './credential-proxy.js';
import { connectNats, ensureStream, ensureConsumer, closeNats, publish } from './nats-client.js';
import { loadAgents, loadManifest, resolveTopicsForAgent, getInstanceId, resolveOutputMap } from './agent-registry.js';
import { AgentManager } from './agent-manager.js';
import { startApiServer } from './api-server.js';
import { McpGateway, type GatewayOptions } from './mcp-gateway.js';
import { TicketRegistry } from './tickets/registry.js';
import { LocalTicketProvider } from './tickets/local-provider.js';
import { TicketProxy } from './tickets/proxy.js';
import { GitHubIssuesProvider } from './tickets/github-provider.js';
import { detectSetupMode, isSetupRequired } from './setup-detector.js';
import { ConfigService } from './config-service.js';
import { startEmbeddedNats, stopEmbeddedNats } from './nats-embedded.js';
import { SecretStore } from './secret-store.js';
import { SecretManager } from './secret-manager.js';
import { McpServerRegistry } from './mcp-server-registry.js';
import { McpManager } from './mcp-manager.js';
import { WorkspaceProvider } from './workspace-provider.js';
// SoulDispatcher removed — replaced by Soul MCP tools

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_HUB_URL = process.env.HUB_URL ?? 'https://github.com/nano-agent-team/core-hub.git';
const HUB_CACHE_DIR = '/tmp/hub';

/**
 * Base agents — always present in every instance.
 * Installed from hub on first startup, started automatically.
 */
const BASE_AGENTS = ['chat-agent', 'consciousness', 'conscience', 'strategist', 'foreman', 'dispatcher'];

/**
 * Fetch the hub catalog and ensure it's available locally.
 * Returns true if hub is ready, false if fetch failed.
 */
function fetchHubCatalog(): boolean {
  const hubUrl = DEFAULT_HUB_URL;

  // Dev mode: file:// URL → use the directory directly (supports uncommitted changes)
  if (hubUrl.startsWith('file://')) {
    const localPath = hubUrl.replace('file://', '');
    if (fs.existsSync(path.join(localPath, 'agents'))) {
      // Symlink or copy to HUB_CACHE_DIR so the rest of the code uses a consistent path
      if (!fs.existsSync(HUB_CACHE_DIR)) {
        fs.symlinkSync(localPath, HUB_CACHE_DIR);
        logger.info({ localPath }, 'Hub: symlinked local directory (dev mode)');
      }
      return true;
    }
    logger.error({ localPath }, 'Hub: file:// path has no agents/ directory');
    return false;
  }

  const ghToken = process.env.GH_TOKEN;
  let cloneUrl = hubUrl;
  if (ghToken && hubUrl.includes('github.com')) {
    cloneUrl = hubUrl.replace('https://', `https://oauth2:${ghToken}@`);
  }

  try {
    const gitEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      HOME: process.env.HOME ?? '/root',
      GIT_TERMINAL_PROMPT: '0',
    };
    if (fs.existsSync(path.join(HUB_CACHE_DIR, '.git'))) {
      logger.info('Hub cache exists — pulling latest');
      try {
        execFileSync('git', ['pull', '--ff-only'], { cwd: HUB_CACHE_DIR, env: gitEnv, timeout: 30_000 });
      } catch {
        logger.warn('Hub pull failed — using cached version');
      }
      return true;
    } else if (fs.existsSync(path.join(HUB_CACHE_DIR, 'agents'))) {
      // Hub dir exists without .git (e.g. copied manually or via Docker COPY) — use as-is
      logger.info('Hub cache exists (no .git) — using as-is');
      return true;
    } else {
      logger.info({ hubUrl }, 'Cloning hub catalog');
      execFileSync('git', ['clone', '--depth=1', cloneUrl, HUB_CACHE_DIR], { env: gitEnv, timeout: 60_000 });
      return true;
    }
  } catch (err) {
    logger.error({ err }, 'Failed to fetch hub catalog');
    // If hub cache has agents dir despite fetch failure, use it anyway
    if (fs.existsSync(path.join(HUB_CACHE_DIR, 'agents'))) {
      logger.warn('Using existing hub cache despite fetch failure');
      return true;
    }
    return false;
  }
}

/**
 * Install a single agent from hub into /data/agents/ if not already present.
 * Returns the loaded agent or null on failure.
 */
function installAgentFromHub(
  dataDir: string,
  agentId: string,
): { manifest: ReturnType<typeof loadManifest>; dir: string } | null {
  const agentDataDir = path.join(dataDir, 'agents', agentId);

  // Already installed — just load
  if (fs.existsSync(path.join(agentDataDir, 'manifest.json'))) {
    logger.debug({ agentId }, 'Base agent already installed');
    try {
      return { manifest: loadManifest(agentDataDir), dir: agentDataDir };
    } catch (err) {
      logger.error({ err, agentId }, 'Base agent manifest invalid');
      return null;
    }
  }

  // Install from hub cache
  const hubAgentDir = path.join(HUB_CACHE_DIR, 'agents', agentId);
  if (!fs.existsSync(path.join(hubAgentDir, 'manifest.json'))) {
    logger.error({ agentId, hubAgentDir }, 'Base agent not found in hub');
    return null;
  }

  fs.mkdirSync(agentDataDir, { recursive: true });
  execFileSync('cp', ['-r', `${hubAgentDir}/.`, agentDataDir], { timeout: 10_000 });
  logger.info({ agentId }, 'Base agent installed from hub');

  try {
    return { manifest: loadManifest(agentDataDir), dir: agentDataDir };
  } catch (err) {
    logger.error({ err, agentId }, 'Base agent manifest invalid after install');
    return null;
  }
}

/**
 * Bootstrap all base agents from hub catalog.
 * Returns array of successfully loaded agents (persistent ones only — ephemeral agents like conscience are not started).
 */
async function bootstrapBaseAgents(
  dataDir: string,
): Promise<Array<{ manifest: ReturnType<typeof loadManifest>; dir: string }>> {
  if (!fetchHubCatalog()) {
    logger.error('Cannot bootstrap base agents — hub fetch failed');
    return [];
  }

  // Copy ARCHITECTURE.md from hub to data dir so agent-manager can mount it into containers
  const hubArchPath = path.join(HUB_CACHE_DIR, 'ARCHITECTURE.md');
  const dataArchPath = path.join(dataDir, 'ARCHITECTURE.md');
  if (fs.existsSync(hubArchPath)) {
    fs.copyFileSync(hubArchPath, dataArchPath);
    logger.debug('Copied ARCHITECTURE.md from hub to data dir');
  }

  const agents: Array<{ manifest: ReturnType<typeof loadManifest>; dir: string }> = [];
  for (const agentId of BASE_AGENTS) {
    const agent = installAgentFromHub(dataDir, agentId);
    if (agent) {
      agents.push(agent);
    }
  }

  logger.info({ installed: agents.map(a => a.manifest.id) }, 'Base agents bootstrapped');
  return agents;
}

async function main(): Promise<void> {
  // ── 1. Detect setup mode ────────────────────────────────────────────────────
  const setupMode = await detectSetupMode(DATA_DIR);
  logger.info({ setupMode, dataDir: DATA_DIR }, 'Starting nano-agent-team');

  // ── 1b. Start credential proxy (if credentials.json exists) ─────────────────
  let proxyServer: http.Server | null = null;
  const credPath = path.join(DATA_DIR, 'credentials.json');

  function startProxyIfNeeded(): void {
    if (proxyServer) return; // already running
    if (!fs.existsSync(credPath)) return;
    startCredentialProxy(DATA_DIR).then((server) => {
      proxyServer = server;
      logger.info('Credential proxy started on :8082');
      startAutoRefresh(DATA_DIR, () => {
        logger.info('Token auto-refreshed — reloading agents for fresh gate-pass token');
        void fetch(`http://localhost:${process.env.API_PORT ?? '3001'}/internal/reload`, { method: 'POST' }).catch(() => {});
      });
    }).catch((err) => {
      logger.error({ err }, 'Failed to start credential proxy');
    });
  }

  startProxyIfNeeded();

  // Watch for credentials.json creation (OAuth completes after first-run setup)
  // Check every 5s — simple, no fs.watch complexity
  const proxyWatchTimer = setInterval(() => {
    if (proxyServer) { clearInterval(proxyWatchTimer); return; }
    startProxyIfNeeded();
  }, 5_000);

  // ── 2. Start embedded NATS if needed, then connect ─────────────────────────
  // NATS_EMBEDDED=true (or default in Docker) → spawn nats-server subprocess
  // If NATS_URL is explicitly set to a remote URL, skip embedded
  const useEmbedded = process.env.NATS_EMBEDDED !== 'false' && !process.env.NATS_URL;
  const natsUrl = useEmbedded ? await startEmbeddedNats() : NATS_URL;

  const nc = await connectNats(natsUrl);

  // ── 3. Ensure AGENTS stream ─────────────────────────────────────────────────
  await ensureStream(nc, 'AGENTS', ['agent.>', 'topic.>', 'health.>', 'soul.>', 'user.message.>', 'secret.>', 'pipeline.>']);
  logger.info('Stream AGENTS ready');

  const configService = new ConfigService(DATA_DIR);

  // ── Alarm Clock ───────────────────────────────────────────────────────────
  const { AlarmClock } = await import('./alarm-clock.js');
  const alarmClock = new AlarmClock(nc, DATA_DIR);

  // ── Secret store + SecretManager + MCP server registry + MCP manager ────────
  const secretStore = new SecretStore();
  const secretManager = new SecretManager(DATA_DIR);

  const manager = new AgentManager(nc, configService, alarmClock, secretManager);
  const mcpServerRegistry = new McpServerRegistry();
  mcpServerRegistry.load();
  const mcpManager = new McpManager(secretStore);

  // ── Ticket registry — TicketProxy routes by ID prefix across backends ────────
  const ticketRegistry = new TicketRegistry(nc);
  const localProvider = new LocalTicketProvider();
  const ticketProxy = new TicketProxy(localProvider);

  // Register GitHub Issues provider if GH_TOKEN + repo config are available
  const ghToken = secretStore.get('GH_TOKEN');
  if (ghToken) {
    try {
      const appCfgRaw = await configService.load() as unknown as Record<string, unknown>;
      const ghConfig = (appCfgRaw?.tickets as Record<string, unknown> | undefined)?.github as
        { owner?: string; repo?: string } | undefined;
      if (ghConfig?.owner && ghConfig?.repo) {
        const ghProvider = new GitHubIssuesProvider({
          owner: ghConfig.owner,
          repo:  ghConfig.repo,
          token: ghToken,
        });
        ticketProxy.registerPrefix('GH', ghProvider);
        // Set GitHub as primary if configured
        const primary = (appCfgRaw?.tickets as Record<string, unknown> | undefined)?.primary as string | undefined;
        if (primary === 'github') ticketProxy.setPrimary('github');
        logger.info({ owner: ghConfig.owner, repo: ghConfig.repo }, 'GitHub Issues provider registered');
      }
    } catch { /* config not ready yet — skip */ }
  }

  ticketRegistry.registerGlobal(ticketProxy);

  const gatewayOpts: GatewayOptions = {
    dataDir: DATA_DIR,
    featuresDir: path.join(DATA_DIR, 'features'),
    teamsDir: path.join(DATA_DIR, 'teams'),
    mcpServersDir: path.join(DATA_DIR, 'mcp-servers'),
    apiPort: String(process.env.API_PORT ?? '3001'),
    hubUrl: process.env.HUB_URL,
    alarmClock,
    nc,
  };

  const mcpGateway = new McpGateway(
    ticketRegistry,
    (agentId) => {
      // Hot-reload: re-read manifest from disk on each request for fresh permissions
      try {
        const manifestPath = path.join(DATA_DIR, 'agents', agentId, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const fresh = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          return fresh.mcp_permissions ?? {};
        }
      } catch { /* fallback to in-memory */ }
      const agent = manager.getAgent(agentId);
      return agent?.manifest.mcp_permissions ?? {};
    },
    (agentId) => {
      const agent = manager.getAgent(agentId);
      return (agent?.manifest.mcp_access as Record<string, string[] | '*'>) ?? {};
    },
    mcpManager,
    mcpServerRegistry,
    gatewayOpts,
    (agentId) => {
      // Hot-reload: re-read manifest from disk for fresh output map
      try {
        const manifestPath = path.join(DATA_DIR, 'agents', agentId, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const fresh = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          return resolveOutputMap(fresh);
        }
      } catch { /* fallback to in-memory */ }
      const agent = manager.getAgent(agentId);
      return agent ? resolveOutputMap(agent.manifest) : {};
    },
    () => {
      return manager.getAllAgents().map(a => ({
        id: a.manifest.id,
        status: a.status,
        description: a.manifest.description ?? '',
      }));
    },
  );
  mcpGateway.start(MCP_GATEWAY_PORT);

  // ── 4. Bootstrap base agents (always, regardless of setup mode) ──────────
  const baseAgents = await bootstrapBaseAgents(DATA_DIR);

  // Start persistent base agents (skip ephemeral like conscience — they launch on demand)
  const persistentBaseAgents = baseAgents.filter(a => !a.manifest.workspace_source);
  for (const agent of persistentBaseAgents) {
    const topics = resolveTopicsForAgent(agent.manifest);
    await ensureConsumer(nc, 'AGENTS', agent.manifest.id, topics);
  }

  // Ensure consumer for ephemeral base agents too (conscience needs soul.idea.pending consumer)
  const ephemeralBaseAgents = baseAgents.filter(a => !!a.manifest.workspace_source);
  for (const agent of ephemeralBaseAgents) {
    const topics = resolveTopicsForAgent(agent.manifest);
    await ensureConsumer(nc, 'AGENTS', agent.manifest.id, topics);
  }

  if (isSetupRequired(setupMode)) {
    // ── 4a. Setup mode — start base agents for setup ────────────────────────────
    logger.info({ setupMode }, 'Setup mode active — starting base agents');

    if (persistentBaseAgents.length > 0) {
      await manager.startAll(persistentBaseAgents);
      manager.startHealthMonitoring();
      // Soul Dispatcher disabled — testing if agents can publish NATS themselves
      logger.info({ agents: persistentBaseAgents.map(a => a.manifest.id) }, 'Base agents started — ready for setup');
    } else {
      logger.warn('No base agents bootstrapped — setup UI will run without agents');
    }

  } else {
    // ── 5b. Ready mode ─────────────────────────────────────────────────────────
    const appConfig = await configService.load();

    // Agent loading is deferred to reloadFeatures() (called by startApiServer)
    // which handles workflow bindings, team context, and proper consumer setup.
    // Do NOT load agents here — it would create consumers without bindings.

    // Start MCP server containers for all registered servers that have their secrets ready
    for (const mcpServer of mcpServerRegistry.getAll()) {
      const missing = secretStore.getMissing(mcpServer.required_secrets);
      if (missing.length > 0) {
        logger.info(
          { id: mcpServer.id, missing },
          'MCP server skipped — secrets not configured yet',
        );
        continue;
      }
      await mcpManager.start(mcpServer);
    }

    manager.startHealthMonitoring();

    // Publish health.check every 30 minutes (Scrum Master agent listens)
    setInterval(() => {
      void publish(nc, 'topic.health.check', JSON.stringify({ ts: Date.now() }));
      logger.debug('Published topic.health.check');
    }, 30 * 60 * 1000);

    // Log installed features/teams
    if (appConfig?.installed) {
      logger.info(
        { features: appConfig.installed.features, teams: appConfig.installed.teams },
        'Installed packages loaded',
      );
    }
  }

  // ── 5c. Workspace Provider (if workspaceRepos configured) ──────────────────
  let workspaceProvider: WorkspaceProvider | undefined;
  {
    const cfg = await configService.load();
    const workspaceRepos = cfg?.workspaceRepos;
    if (workspaceRepos && Object.keys(workspaceRepos).length > 0) {
      workspaceProvider = new WorkspaceProvider(path.join(DATA_DIR, 'workspaces'), workspaceRepos);
      workspaceProvider.startPeriodicFetch();
      logger.info({ repos: Object.keys(workspaceRepos) }, 'WorkspaceProvider started');
    }
  }

  // ── Floating timer: wake consciousness after configurable silence ────────
  {
    const silenceMinutes = (() => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
        return cfg.silenceTimeoutMinutes ?? 30;
      } catch { return 30; }
    })();
    const SILENCE_TIMEOUT_MS = silenceMinutes * 60 * 1000;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;

    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(async () => {
        logger.info('Global silence %d min — waking consciousness', silenceMinutes);
        try {
          // Build system state summary so consciousness can make informed decisions
          const agents = manager.getAllAgents().map(a => `${a.manifest.id} (${a.status})`).join(', ');
          await publish(nc, 'soul.consciousness.inbox', JSON.stringify({
            type: 'reflection',
            reason: `Global silence for ${silenceMinutes} minutes. System state: agents=[${agents}]. Review Obsidian — check goals, plans, tasks, research outputs, and journal. What needs attention? Are there completed plans the user should know about?`,
            ts: Date.now(),
          }));
        } catch (err) { logger.error({ err }, 'Failed to wake consciousness'); }
      }, SILENCE_TIMEOUT_MS);
    }

    // Track business-relevant NATS activity (core sub sees JetStream publishes too)
    for (const pattern of ['soul.>', 'pipeline.>', 'agent.>']) {
      const sub = nc.subscribe(pattern);
      void (async () => { for await (const _msg of sub) { resetSilenceTimer(); } })();
    }
    resetSilenceTimer();
    logger.info({ timeoutMs: SILENCE_TIMEOUT_MS }, 'Floating silence timer started');
  }

  // ── 6. Start API server ─────────────────────────────────────────────────────
  // Settings feature is always loaded inside startApiServer
  const httpServer = await startApiServer(manager, nc, configService, { setupMode, mcpManager, mcpGateway, ticketRegistry, workspaceProvider, secretManager });

  // ── 6b. Post-restart deploy verification ──────────────────────────────────
  const pendingDeployPath = path.join(DATA_DIR, 'pending-deploy.json');
  if (fs.existsSync(pendingDeployPath)) {
    try {
      const deployContext = JSON.parse(fs.readFileSync(pendingDeployPath, 'utf8'));
      logger.info({ deployContext }, 'Pending deploy detected — running health check');

      // Small delay to let everything settle
      await new Promise((r) => setTimeout(r, 2000));

      // Health check via internal API
      let healthy = false;
      try {
        const apiPort = process.env.API_PORT ?? '3001';
        const healthRes = await fetch(`http://localhost:${apiPort}/api/health`);
        healthy = healthRes.ok;
      } catch (err) {
        logger.error({ err }, 'Health check request failed');
      }

      if (healthy) {
        logger.info('Post-restart health check passed — deploy successful');
        await publish(nc, 'topic.deploy.done', JSON.stringify({
          ticket_id: deployContext.ticket_id,
          workspaceId: deployContext.workspaceId,
          previousCommit: deployContext.previousMainCommit,
          timestamp: new Date().toISOString(),
        }));
      } else {
        logger.error('Post-restart health check FAILED — attempting rollback');

        // Attempt rollback: revert HEAD in a temp worktree from bare repo
        let rollbackAttempted = false;
        try {
          const bareRepoDir = path.join(DATA_DIR, 'workspaces', 'repos', 'nano-agent-team.git');
          if (fs.existsSync(bareRepoDir)) {
            const { execFileSync: efs } = await import('child_process');
            const tmpWorktree = path.join(DATA_DIR, 'workspaces', 'tmp-rollback');
            try {
              efs('git', ['worktree', 'add', tmpWorktree, 'main'], { cwd: bareRepoDir, timeout: 30_000 });
              efs('git', ['revert', 'HEAD', '--no-edit'], { cwd: tmpWorktree, timeout: 30_000 });
              efs('git', ['worktree', 'remove', tmpWorktree, '--force'], { cwd: bareRepoDir, timeout: 10_000 });
              rollbackAttempted = true;
              logger.info('Rollback revert committed on main');
            } catch (revertErr) {
              logger.error({ err: revertErr }, 'Rollback revert failed');
              // Clean up worktree if it exists
              try { efs('git', ['worktree', 'remove', tmpWorktree, '--force'], { cwd: bareRepoDir, timeout: 10_000 }); } catch { /* ignore */ }
            }
          }
        } catch (err) {
          logger.error({ err }, 'Rollback attempt error');
        }

        await publish(nc, 'topic.deploy.failed', JSON.stringify({
          ticket_id: deployContext.ticket_id,
          workspaceId: deployContext.workspaceId,
          previousCommit: deployContext.previousMainCommit,
          rollbackAttempted,
          timestamp: new Date().toISOString(),
        }));
      }

      // Clean up pending-deploy file regardless of outcome
      try { fs.unlinkSync(pendingDeployPath); } catch { /* ignore */ }
    } catch (err) {
      logger.error({ err }, 'Error processing pending deploy');
      try { fs.unlinkSync(pendingDeployPath); } catch { /* ignore */ }
    }
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...');
    workspaceProvider?.shutdown();
    stopAutoRefresh();
    proxyServer?.close();
    httpServer.close();
    mcpGateway.stop();
    await mcpManager.stopAll();
    await manager.stopAll();
    await manager.stopAllDispatches();
    await closeNats(nc);
    stopEmbeddedNats();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep process alive
  await nc.closed();
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
