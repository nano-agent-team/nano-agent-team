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
import { DATA_DIR, NATS_URL, AGENTS_DIR } from './config.js';
import { logger } from './logger.js';
import { startCredentialProxy } from './credential-proxy.js';
import { connectNats, ensureStream, ensureConsumer, closeNats, publish } from './nats-client.js';
import { loadAgents, loadManifest, resolveTopicsForAgent } from './agent-registry.js';
import { AgentManager } from './agent-manager.js';
import { startApiServer } from './api-server.js';
import { detectSetupMode, isSetupRequired } from './setup-detector.js';
import { ConfigService } from './config-service.js';
import { startEmbeddedNats, stopEmbeddedNats } from './nats-embedded.js';

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
      await ensureConsumer(nc, 'AGENTS', agent.manifest.id, topics);
      logger.info({ id: agent.manifest.id, topics }, 'Agent consumer ready');
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
  await startApiServer(manager, nc, configService, { setupMode });

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...');
    proxyServer?.close();
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
