/**
 * nano-agent-team — startup entry point
 *
 * Startup sequence:
 * 1. Detect setup mode (first-run / setup-incomplete / ready)
 * 2. Connect to NATS JetStream
 * 3. Ensure AGENTS stream
 * 4. Always start settings agent (handles onboarding)
 * 5a. Setup mode: start only settings agent, expose setup UI
 * 5b. Ready mode: load all agents + features from config
 * 6. Start API server
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR, NATS_URL, AGENTS_DIR, MCP_GATEWAY_PORT } from './config.js';
import { logger } from './logger.js';
import { startCredentialProxy } from './credential-proxy.js';
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

  // ── 4. Always register settings agent consumer ──────────────────────────────
  const settingsAgentDir = path.join(path.resolve(AGENTS_DIR), 'settings');
  let settingsAgent;
  try {
    const manifest = loadManifest(settingsAgentDir);
    settingsAgent = { manifest, dir: settingsAgentDir };
    const settingsTopics = resolveTopicsForAgent(manifest);
    await ensureConsumer(nc, 'AGENTS', manifest.id, settingsTopics);
    logger.info({ id: manifest.id, topics: settingsTopics }, 'Settings agent consumer ready');
  } catch (err) {
    logger.warn({ err }, 'Settings agent manifest not found — setup UI will use form-only mode');
  }

  const configService = new ConfigService(DATA_DIR);
  const manager = new AgentManager(nc, configService);

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
    // ── 5a. Setup mode ─────────────────────────────────────────────────────────
    logger.info({ setupMode }, 'Setup mode active');

    // Start only settings agent
    if (settingsAgent) {
      await manager.startAll([settingsAgent]);
      manager.startHealthMonitoring();
    }

  } else {
    // ── 5b. Ready mode ─────────────────────────────────────────────────────────
    const appConfig = await configService.load();

    // Load all agents (built-in + installed from DATA_DIR)
    const agents = loadAgents(AGENTS_DIR);

    const dataAgentsDir = path.join(DATA_DIR, 'agents');
    if (fs.existsSync(dataAgentsDir)) {
      const installedAgents = loadAgents(dataAgentsDir);
      for (const agent of installedAgents) {
        if (!agents.find(a => a.manifest.id === agent.manifest.id)) {
          agents.push(agent);
        }
      }
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
  await startApiServer(manager, nc, configService, { setupMode, mcpManager, mcpGateway });

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...');
    proxyServer?.close();
    mcpGateway.stop();
    await mcpManager.stopAll();
    await manager.stopAll();
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
