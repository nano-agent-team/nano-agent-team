/**
 * API Server — Express HTTP core
 *
 * Built-in routes (core):
 *   GET  /api/health  — agent statuses
 *   GET  /api/events  — SSE stream
 *   GET  /            — static dashboard/dist/
 *
 * Plugin routes are registered via loadTeamPlugins() from team plugin.mjs files.
 * Example: dev-team plugin registers /api/tickets routes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import express, { type Request, type Response } from 'express';
import type { NatsConnection } from 'nats';

import { API_PORT, AGENTS_DIR } from './config.js';
import { logger } from './logger.js';
import { publish } from './nats-client.js';
import type { AgentManager } from './agent-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Plugin interface ─────────────────────────────────────────────────────────

export interface TeamPlugin {
  /** Called once at startup to register routes and NATS listeners */
  register(
    app: express.Application,
    nc: NatsConnection,
    manager: AgentManager,
    opts: {
      emitSseEvent: (event: string, data: unknown) => void;
      publishNats: (subject: string, payload: string) => Promise<void>;
    },
  ): Promise<void>;
}

// ─── SSE clients ─────────────────────────────────────────────────────────────

const sseClients = new Set<Response>();

export function emitSseEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ─── Plugin loader ────────────────────────────────────────────────────────────

/**
 * Scans agents/ subdirectories for plugin.mjs files and loads them.
 * Each team directory (e.g. agents/dev-team/) can have a plugin.mjs that
 * registers additional Express routes and NATS listeners.
 */
async function loadTeamPlugins(
  app: express.Application,
  nc: NatsConnection,
  manager: AgentManager,
): Promise<void> {
  const agentsDir = path.resolve(AGENTS_DIR);
  if (!fs.existsSync(agentsDir)) return;

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const pluginPath = path.join(agentsDir, entry.name, 'plugin.mjs');
    if (!fs.existsSync(pluginPath)) continue;

    try {
      logger.info({ plugin: pluginPath }, 'Loading team plugin');
      const mod = await import(pluginPath) as { default?: TeamPlugin } | TeamPlugin;
      const plugin = ('default' in mod ? mod.default : mod) as TeamPlugin | undefined;

      if (plugin && typeof plugin.register === 'function') {
        const publishNats = async (subject: string, payload: string): Promise<void> => {
          await publish(nc, subject, payload);
        };
        await plugin.register(app, nc, manager, { emitSseEvent, publishNats });
        logger.info({ plugin: pluginPath }, 'Team plugin registered');
      } else {
        logger.warn({ plugin: pluginPath }, 'Plugin has no register() export — skipping');
      }
    } catch (err) {
      logger.error({ err, plugin: pluginPath }, 'Failed to load team plugin');
    }
  }
}

// ─── App factory ─────────────────────────────────────────────────────────────

export async function createApiApp(
  manager: AgentManager,
  nc: NatsConnection,
): Promise<express.Application> {
  const app = express();
  app.use(express.json());

  // ── Core health endpoint ──────────────────────────────────────────────────

  app.get('/api/health', (_req: Request, res: Response) => {
    try {
      const agents = manager.getStates();
      res.json({ status: 'ok', agents, ts: Date.now() });
    } catch (err) {
      logger.error({ err }, 'GET /api/health error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── SSE stream ────────────────────────────────────────────────────────────

  app.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    res.write('event: connected\ndata: {"status":"ok"}\n\n');

    sseClients.add(res);
    logger.debug({ clients: sseClients.size }, 'SSE client connected');

    req.on('close', () => {
      sseClients.delete(res);
      logger.debug({ clients: sseClients.size }, 'SSE client disconnected');
    });
  });

  // ── Load team plugins (registers additional routes) ───────────────────────

  await loadTeamPlugins(app, nc, manager);

  // ── Static dashboard (serve last, after all API routes) ───────────────────

  const distDir = path.join(__dirname, '..', 'dashboard', 'dist');
  app.use(express.static(distDir));

  app.get('*', (_req: Request, res: Response) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, (sendErr) => {
      if (sendErr) {
        res.status(404).send('Dashboard not built. Run: cd dashboard && npm run build');
      }
    });
  });

  return app;
}

// ─── Start server ─────────────────────────────────────────────────────────────

export async function startApiServer(manager: AgentManager, nc: NatsConnection): Promise<void> {
  const app = await createApiApp(manager, nc);

  await new Promise<void>((resolve) => {
    app.listen(API_PORT, () => {
      logger.info({ port: API_PORT }, 'API server listening');
      resolve();
    });
  });
}
