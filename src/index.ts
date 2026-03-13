/**
 * nano-agent-team — startup entry point
 *
 * 1. Connect to NATS JetStream
 * 2. Ensure AGENTS stream exists (agent.>, topic.>, health.>)
 * 3. Load agent manifests from agents/ directory
 * 4. Ensure durable consumers for each agent
 * 5. Start Docker containers via AgentManager
 * 6. Start health monitoring
 * 7. Log "ready"
 */

import { NATS_URL, AGENTS_DIR } from './config.js';
import { logger } from './logger.js';
import { connectNats, ensureStream, ensureConsumer, closeNats, publish } from './nats-client.js';
import { loadAgents } from './agent-registry.js';
import { AgentManager } from './agent-manager.js';
import { startApiServer } from './api-server.js';

async function main(): Promise<void> {
  logger.info({ natsUrl: NATS_URL, agentsDir: AGENTS_DIR }, 'Starting nano-agent-team');

  // Connect to NATS
  const nc = await connectNats(NATS_URL);

  // Ensure AGENTS stream exists (agent.>, topic.>, health.>)
  await ensureStream(nc, 'AGENTS', ['agent.>', 'topic.>', 'health.>']);
  logger.info('Stream AGENTS ready');

  // Load agent manifests
  const agents = loadAgents(AGENTS_DIR);

  if (agents.length === 0) {
    logger.warn('No agents found — add agent directories under agents/');
  }

  // Ensure durable consumer per agent
  for (const agent of agents) {
    await ensureConsumer(nc, 'AGENTS', agent.manifest.id, agent.manifest.subscribe_topics);
    logger.info(
      { id: agent.manifest.id, topics: agent.manifest.subscribe_topics },
      'Agent consumer ready',
    );
  }

  // Start agent containers
  const manager = new AgentManager(nc);
  await manager.startAll(agents);

  // Start health monitoring (Docker API + NATS heartbeats)
  manager.startHealthMonitoring();

  // Start API server (health + SSE + plugin routes + dashboard)
  await startApiServer(manager, nc);

  logger.info(
    { agents: agents.map((a) => a.manifest.id) },
    'nano-agent-team ready',
  );

  // Publish health.check every 30 minutes (Scrum Master agent listens)
  setInterval(() => {
    void publish(nc, 'topic.health.check', JSON.stringify({ ts: Date.now() }));
    logger.debug('Published topic.health.check');
  }, 30 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...');
    await manager.stopAll();
    await closeNats(nc);
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
