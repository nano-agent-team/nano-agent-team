/**
 * nano-agent-team — startup entry point
 *
 * Startup sequence:
 * 1. Detect setup mode (first-run / setup-incomplete / ready)
 * 2. Connect to NATS JetStream
 * 3. Ensure AGENTS stream
 * 4a. Setup mode: bootstrap foreman from hub, start it
 * 4b. Ready mode: load all agents from /data/agents + features from config
 * 5. Start API server
 *
 * Core ships NO built-in agents. All agents come from the hub catalog.
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
import { loadAgents, loadManifest, resolveTopicsForAgent, getInstanceId } from './agent-registry.js';
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
import { McpServerRegistry } from './mcp-server-registry.js';
import { McpManager } from './mcp-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_HUB_URL = process.env.HUB_URL ?? 'https://github.com/nano-agent-team-dev/hub.git';
const HUB_CACHE_DIR = '/tmp/hub';

/**
 * Bootstrap: fetch the hub catalog and install the foreman agent into /data/agents/.
 * Called once during setup mode (first-run / setup-incomplete).
 * If foreman is already installed, skips the hub fetch and returns immediately.
 */
async function bootstrapForeman(
  dataDir: string,
): Promise<{ manifest: ReturnType<typeof loadManifest>; dir: string } | null> {
  const foremanDataDir = path.join(dataDir, 'agents', 'foreman');

  // Already installed — just load and return
  if (fs.existsSync(path.join(foremanDataDir, 'manifest.json'))) {
    logger.info('Foreman already installed, skipping hub fetch');
    try {
      return { manifest: loadManifest(foremanDataDir), dir: foremanDataDir };
    } catch (err) {
      logger.error({ err }, 'Foreman manifest invalid — cannot bootstrap');
      return null;
    }
  }

  // Clone or update hub
  const hubUrl = DEFAULT_HUB_URL;
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
      execFileSync('git', ['pull', '--ff-only'], { cwd: HUB_CACHE_DIR, env: gitEnv, timeout: 30_000 });
    } else {
      logger.info({ hubUrl }, 'Cloning hub catalog');
      execFileSync('git', ['clone', '--depth=1', cloneUrl, HUB_CACHE_DIR], { env: gitEnv, timeout: 60_000 });
    }
  } catch (err) {
    logger.error({ err }, 'Failed to fetch hub catalog — cannot bootstrap foreman');
    return null;
  }

  const foremanHubDir = path.join(HUB_CACHE_DIR, 'agents', 'foreman');
  if (!fs.existsSync(path.join(foremanHubDir, 'manifest.json'))) {
    logger.error({ foremanHubDir }, 'Foreman agent not found in hub');
    return null;
  }

  // Install foreman into /data/agents/foreman
  fs.mkdirSync(foremanDataDir, { recursive: true });
  execFileSync('cp', ['-r', `${foremanHubDir}/.`, foremanDataDir], { timeout: 10_000 });
  logger.info('Foreman installed from hub');

  try {
    return { manifest: loadManifest(foremanDataDir), dir: foremanDataDir };
  } catch (err) {
    logger.error({ err }, 'Foreman manifest invalid after install');
    return null;
  }
}

async function main(): Promise<void> {
  // ── 1. Detect setup mode ────────────────────────────────────────────────────
  const setupMode = await detectSetupMode(DATA_DIR);
  logger.info({ setupMode, dataDir: DATA_DIR }, 'Starting nano-agent-team');

  // ── 1b. Start credential proxy (if credentials.json exists) ─────────────────
  let proxyServer: http.Server | null = null;
  const credPath = path.join(DATA_DIR, 'credentials.json');
  if (fs.existsSync(credPath)) {
    proxyServer = await startCredentialProxy(DATA_DIR);
    logger.info('Credential proxy started on :8082');

    // Auto-refresh OAuth token before expiry.
    // Proxy reads fresh token per-request from credentials.json, so agent reload
    // is not strictly needed — but we reload to update the gate-pass CLAUDE_CODE_OAUTH_TOKEN
    // env var that SDK uses for its internal login check.
    startAutoRefresh(DATA_DIR, () => {
      logger.info('Token auto-refreshed — reloading agents for fresh gate-pass token');
      void fetch(`http://localhost:${process.env.API_PORT ?? '3001'}/internal/reload`, { method: 'POST' }).catch(() => {});
    });
  }

  // ── 2. Start embedded NATS if needed, then connect ─────────────────────────
  // NATS_EMBEDDED=true (or default in Docker) → spawn nats-server subprocess
  // If NATS_URL is explicitly set to a remote URL, skip embedded
  const useEmbedded = process.env.NATS_EMBEDDED !== 'false' && !process.env.NATS_URL;
  const natsUrl = useEmbedded ? await startEmbeddedNats() : NATS_URL;

  const nc = await connectNats(natsUrl);

  // ── 3. Ensure AGENTS stream ─────────────────────────────────────────────────
  await ensureStream(nc, 'AGENTS', ['agent.>', 'topic.>', 'health.>']);
  logger.info('Stream AGENTS ready');

  const configService = new ConfigService(DATA_DIR);

  // ── Alarm Clock ───────────────────────────────────────────────────────────
  const { AlarmClock } = await import('./alarm-clock.js');
  const alarmClock = new AlarmClock(nc, DATA_DIR);

  const manager = new AgentManager(nc, configService, alarmClock);

  // ── Secret store + MCP server registry + MCP manager ────────────────────────
  const secretStore = new SecretStore();
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
  };

  const mcpGateway = new McpGateway(
    ticketRegistry,
    (agentId) => {
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
  );
  mcpGateway.start(MCP_GATEWAY_PORT);

  if (isSetupRequired(setupMode)) {
    // ── 4a. Setup mode — bootstrap foreman from hub ─────────────────────────────
    logger.info({ setupMode }, 'Setup mode active — bootstrapping foreman from hub');

    const foremanAgent = await bootstrapForeman(DATA_DIR);
    if (foremanAgent) {
      const foremanTopics = resolveTopicsForAgent(foremanAgent.manifest);
      await ensureConsumer(nc, 'AGENTS', foremanAgent.manifest.id, foremanTopics);
      await manager.startAll([foremanAgent]);
      manager.startHealthMonitoring();
      logger.info('Foreman started — ready for setup');
    } else {
      logger.warn('Foreman bootstrap failed — setup UI will run without conversational agent');
    }

  } else {
    // ── 5b. Ready mode ─────────────────────────────────────────────────────────
    const appConfig = await configService.load();

    // Load all agents from /data/agents/ (installed from hub — no built-ins in core)
    const agents: ReturnType<typeof loadAgents> = [];
    const dataAgentsDir = path.join(DATA_DIR, 'agents');
    if (fs.existsSync(dataAgentsDir)) {
      agents.push(...loadAgents(dataAgentsDir));
    }

    for (const agent of agents) {
      const topics = resolveTopicsForAgent(agent.manifest, agent.binding);
      await ensureConsumer(nc, 'AGENTS', getInstanceId(agent), topics);
      logger.info({ id: getInstanceId(agent), topics }, 'Agent consumer ready');
    }

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

    await manager.startAll(agents);
    manager.startHealthMonitoring();

    logger.info(
      { agents: agents.map((a) => a.manifest.id) },
      'nano-agent-team ready',
    );

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

  // ── 6. Start API server ─────────────────────────────────────────────────────
  // Settings feature is always loaded inside startApiServer
  await startApiServer(manager, nc, configService, { setupMode, mcpManager, mcpGateway, ticketRegistry });

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...');
    stopAutoRefresh();
    proxyServer?.close();
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
