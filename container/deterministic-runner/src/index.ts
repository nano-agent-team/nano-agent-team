/**
 * Deterministic Runner — executes TypeScript handlers without LLM.
 *
 * Env vars:
 *   NATS_URL        — NATS server URL
 *   AGENT_ID        — unique agent id
 *   CONSUMER_NAME   — JetStream consumer name
 *   MCP_GATEWAY_URL — MCP Gateway HTTP endpoint
 *   HANDLER         — handler module name (e.g., "scrum-master")
 *   DB_PATH         — SQLite DB path (read-only)
 *   LOG_LEVEL       — pino log level (default: info)
 */

import { connect, StringCodec } from 'nats';
import type { Consumer } from 'nats';
import Database from 'better-sqlite3';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Handler, HandlerContext } from './types.js';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const AGENT_ID = process.env.AGENT_ID ?? 'unknown';
const CONSUMER_NAME = process.env.CONSUMER_NAME ?? AGENT_ID;
const HANDLER_NAME = process.env.HANDLER;
const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? '';
const DB_PATH = process.env.DB_PATH ?? '/workspace/db/nano-agent-team.db';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const HEARTBEAT_INTERVAL_MS = 15_000;

if (!HANDLER_NAME) {
  console.error('HANDLER env var is required');
  process.exit(1);
}

const log = pino(
  { level: LOG_LEVEL },
  pino.transport({ target: 'pino-pretty', options: { colorize: false, destination: 2 } }),
);

async function main(): Promise<void> {
  // Import handler module
  let handler: Handler;
  try {
    const mod = await import(`./handlers/${HANDLER_NAME}.js`);
    handler = mod.default ?? mod.handle;
    if (typeof handler !== 'function') throw new Error('Handler must export a function');
  } catch (err) {
    log.fatal({ err, handler: HANDLER_NAME }, 'Failed to load handler');
    process.exit(1);
  }

  // Open DB read-only
  const db = new Database(DB_PATH, { readonly: true });

  // Connect to NATS
  const nc = await connect({ servers: NATS_URL, name: `deterministic-${AGENT_ID}` });
  const codec = StringCodec();
  log.info({ agentId: AGENT_ID, handler: HANDLER_NAME, natsUrl: NATS_URL }, 'Deterministic runner starting');

  // Heartbeat
  let isBusy = false;
  const heartbeatTimer = setInterval(() => {
    try {
      nc.publish(`health.${AGENT_ID}`, codec.encode(JSON.stringify({
        agentId: AGENT_ID, ts: Date.now(), busy: isBusy,
      })));
    } catch {
      clearInterval(heartbeatTimer);
      process.exit(0);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // JetStream consumer
  const js = nc.jetstream();
  let consumer: Consumer;
  try {
    consumer = await js.consumers.get('AGENTS', CONSUMER_NAME);
  } catch (err) {
    log.fatal({ err, consumerName: CONSUMER_NAME }, 'Failed to get JetStream consumer');
    clearInterval(heartbeatTimer);
    await nc.drain();
    process.exit(1);
  }

  // Connect MCP client (handles SSE transport used by MCP Gateway)
  const mcpClient = new Client({ name: `deterministic-${AGENT_ID}`, version: '1.0.0' });
  const mcpTransport = new StreamableHTTPClientTransport(
    new URL(MCP_GATEWAY_URL),
    { requestInit: { headers: { 'x-agent-id': AGENT_ID } } },
  );
  await mcpClient.connect(mcpTransport);
  log.info({ mcpGatewayUrl: MCP_GATEWAY_URL }, 'MCP client connected');

  // Ready signal
  nc.publish(`agent.${AGENT_ID}.ready`, codec.encode(JSON.stringify({ agentId: AGENT_ID, ts: Date.now() })));
  log.info({ agentId: AGENT_ID }, 'Deterministic runner ready');

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down deterministic runner');
    clearInterval(heartbeatTimer);
    db.close();
    nc.drain().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Build handler context
  const ctx: HandlerContext = { agentId: AGENT_ID, nc, mcp: mcpClient, db, log };

  // Message processing loop
  for await (const msg of await consumer.consume()) {
    let payload: unknown;
    try {
      payload = JSON.parse(codec.decode(msg.data));
    } catch {
      log.warn({ subject: msg.subject }, 'Non-JSON message — skipping');
      msg.ack();
      continue;
    }

    isBusy = true;
    const workingTimer = setInterval(() => {
      try { msg.working(); } catch { /* ignore */ }
    }, 30_000);

    try {
      await handler(payload, ctx);
    } catch (err) {
      log.error({ err, agentId: AGENT_ID, handler: HANDLER_NAME }, 'Handler error');
    } finally {
      clearInterval(workingTimer);
    }

    isBusy = false;
    msg.ack();
  }
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal deterministic runner error');
  process.exit(1);
});
