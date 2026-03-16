/**
 * API Server — Express HTTP core
 *
 * Built-in routes (core):
 *   GET  /api/health        — agent statuses
 *   GET  /api/events        — SSE stream
 *   POST /api/chat/settings — NATS bridge for settings agent
 *   POST /internal/reload   — live reload features after setup_complete
 *   GET  /                  — static dashboard/dist/
 *
 * Plugin routes are registered via loadFeature() from features/{id}/plugin.mjs
 * and via loadTeamPlugins() from agents/{id}/plugin.mjs (legacy).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import express, { type Request, type Response } from 'express';
import { StringCodec, type NatsConnection } from 'nats';

import { API_PORT, AGENTS_DIR, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { publish, ensureConsumer } from './nats-client.js';
import { isTracingEnabled } from './tracing/init.js';
import type { AgentManager } from './agent-manager.js';
import type { ConfigService } from './config-service.js';
import type { SetupMode } from './setup-detector.js';
import { listTickets, getTicket, createTicket, updateTicket, addComment, listComments, type TicketStatus, type TicketPriority, type TicketType } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codec = StringCodec();

// ─── Plugin / Feature interface ───────────────────────────────────────────────

interface PluginRoute { path: string; component: string; nav?: { label: string; icon: string } }
interface PluginInfo {
  id: string;
  name: string;
  uiEntry: string | null;
  routes: PluginRoute[];
}

export interface TeamPlugin {
  /** Called once at startup to register routes and NATS listeners */
  register(
    app: express.Application,
    nc: NatsConnection,
    manager: AgentManager,
    opts: {
      emitSseEvent: (event: string, data: unknown) => void;
      publishNats: (subject: string, payload: string) => Promise<void>;
      dataDir: string;
      configService: ConfigService;
      reloadFeatures: () => Promise<void>;
      registerPlugin?: (info: PluginInfo) => void;
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

// ─── Feature loader ───────────────────────────────────────────────────────────

const loadedFeatures = new Map<string, boolean>();
const FEATURES_DIR = path.join(__dirname, '..', 'features');

export async function loadFeature(
  featureId: string,
  app: express.Application,
  nc: NatsConnection,
  manager: AgentManager,
  configService: ConfigService,
  reloadFeatures: () => Promise<void>,
): Promise<void> {
  if (loadedFeatures.has(featureId)) return;

  // Check built-in features dir first, then installed features in /data/features/
  const builtinPath = path.join(FEATURES_DIR, featureId);
  const installedPath = path.join(DATA_DIR, 'features', featureId);
  const featurePath = fs.existsSync(path.join(builtinPath, 'feature.json')) ? builtinPath : installedPath;
  const featureJsonPath = path.join(featurePath, 'feature.json');

  if (!fs.existsSync(featureJsonPath)) {
    logger.warn({ featureId, featurePath }, 'Feature not found — skipping');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(featureJsonPath, 'utf8')) as {
    plugin: string;
    id: string;
  };
  const pluginPath = path.join(featurePath, manifest.plugin);

  try {
    logger.info({ featureId, pluginPath }, 'Loading feature');
    // ?v= cache-buster forces Node to re-evaluate the module on each reload call.
    // Node's ESM loader caches by full specifier, so without this a hot-reload
    // would silently serve the old module instance.
    const mod = await import(`${pluginPath}?v=${Date.now()}`) as { default?: TeamPlugin } | TeamPlugin;
    const plugin = ('default' in mod ? mod.default : mod) as TeamPlugin | undefined;

    if (plugin && typeof plugin.register === 'function') {
      await plugin.register(app, nc, manager, {
        emitSseEvent,
        publishNats: async (subject, payload) => { await publish(nc, subject, payload); },
        dataDir: DATA_DIR,
        configService,
        reloadFeatures,
      });
      loadedFeatures.set(featureId, true);
      logger.info({ featureId }, 'Feature loaded');
    } else {
      logger.warn({ featureId }, 'Feature plugin has no register() — skipping');
    }
  } catch (err) {
    logger.error({ err, featureId }, 'Failed to load feature');
  }
}

// ─── Team plugin loader ──────────────────────────────────────────────────────
// Scans for plugin.mjs in:
//   1. AGENTS_DIR/*/plugin.mjs (built-in agents)
//   2. DATA_DIR/teams/*/agents/plugin.mjs (installed teams)

async function loadTeamPlugins(
  app: express.Application,
  nc: NatsConnection,
  manager: AgentManager,
  configService: ConfigService,
  reloadFeatures: () => Promise<void>,
): Promise<void> {
  const pluginPaths: string[] = [];

  // 1. Built-in agents dir
  const agentsDir = path.resolve(AGENTS_DIR);
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const p = path.join(agentsDir, entry.name, 'plugin.mjs');
      if (fs.existsSync(p)) pluginPaths.push(p);
    }
  }

  // 2. Installed teams in DATA_DIR/teams/*/
  // Check both plugin.mjs (top-level, e.g. from plugin-dist) and agents/plugin.mjs (legacy)
  const teamsDir = path.join(DATA_DIR, 'teams');
  if (fs.existsSync(teamsDir)) {
    for (const team of fs.readdirSync(teamsDir, { withFileTypes: true })) {
      if (!team.isDirectory()) continue;
      const topLevel = path.join(teamsDir, team.name, 'plugin.mjs');
      const agentsLevel = path.join(teamsDir, team.name, 'agents', 'plugin.mjs');
      if (fs.existsSync(topLevel)) pluginPaths.push(topLevel);
      else if (fs.existsSync(agentsLevel)) pluginPaths.push(agentsLevel);
    }
  }

  for (const pluginPath of pluginPaths) {
    try {
      logger.info({ plugin: pluginPath }, 'Loading team plugin');
      // ?v= cache-buster — same rationale as in loadFeaturePlugin above.
      const mod = await import(`${pluginPath}?v=${Date.now()}`) as { default?: TeamPlugin } | TeamPlugin;
      const plugin = ('default' in mod ? mod.default : mod) as TeamPlugin | undefined;

      if (plugin && typeof plugin.register === 'function') {
        await plugin.register(app, nc, manager, {
          emitSseEvent,
          publishNats: async (subject, payload) => { await publish(nc, subject, payload); },
          dataDir: DATA_DIR,
          configService,
          reloadFeatures,
          registerPlugin: (info: PluginInfo) => {
            if (!externalPlugins.find(p => p.id === info.id)) {
              externalPlugins.push(info);
            }
          },
        });
        logger.info({ plugin: pluginPath }, 'Team plugin registered');
      } else {
        logger.warn({ plugin: pluginPath }, 'Plugin has no register() — skipping');
      }
    } catch (err) {
      logger.error({ err, plugin: pluginPath }, 'Failed to load team plugin');
    }
  }
}

// ─── Plugin list for dashboard ────────────────────────────────────────────────

const mountedStatic = new Set<string>();
const externalPlugins: PluginInfo[] = [];

async function getPluginList(app?: express.Application): Promise<PluginInfo[]> {
  const list: PluginInfo[] = [];

  function scanDir(dir: string, urlPrefix: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const featureJsonPath = path.join(dir, entry.name, 'feature.json');
      if (!fs.existsSync(featureJsonPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(featureJsonPath, 'utf8')) as {
          id: string; name: string;
          frontend?: { remote: string; routes?: PluginRoute[] };
        };
        const remotePath = manifest.frontend?.remote
          ? path.join(dir, entry.name, manifest.frontend.remote)
          : null;
        const uiEntry = remotePath && fs.existsSync(remotePath)
          ? `${urlPrefix}/${entry.name}/${manifest.frontend!.remote}`
          : null;

        // Mount static files for this feature if not already done
        if (app && !mountedStatic.has(entry.name)) {
          app.use(`${urlPrefix}/${entry.name}`, express.static(path.join(dir, entry.name)));
          mountedStatic.add(entry.name);
        }

        if (!list.find(p => p.id === manifest.id)) {
          list.push({
            id: manifest.id,
            name: manifest.name,
            uiEntry,
            routes: manifest.frontend?.routes ?? [],
          });
        }
      } catch { /* ignore */ }
    }
  }

  scanDir(FEATURES_DIR, '/features');
  scanDir(path.join(DATA_DIR, 'features'), '/features/data');

  // Add plugins registered by team plugins via registerPlugin()
  for (const p of externalPlugins) {
    if (!list.find(l => l.id === p.id)) {
      list.push(p);
    }
  }

  return list;
}

// ─── App factory ─────────────────────────────────────────────────────────────

export async function createApiApp(
  manager: AgentManager,
  nc: NatsConnection,
  configService: ConfigService,
  opts: { setupMode: SetupMode },
): Promise<express.Application> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // OTel span enrichment — give spans meaningful names after Express routing
  if (isTracingEnabled()) {
    app.use((req, _res, next) => {
      try {
        const otelApi = (globalThis as Record<string, unknown>).__otelApi as typeof import('@opentelemetry/api') | undefined;
        if (otelApi) {
          const span = otelApi.trace.getActiveSpan();
          if (span) {
            // Will be enriched again in res.on('finish') with matched route
            span.setAttribute('http.target', req.url);
          }
        }
      } catch { /* noop */ }
      next();
    });

    // After response — set final span name from matched Express route
    app.use((req, res, next) => {
      res.on('finish', () => {
        try {
          const otelApi = (globalThis as Record<string, unknown>).__otelApi as typeof import('@opentelemetry/api') | undefined;
          if (!otelApi) return;
          const span = otelApi.trace.getActiveSpan();
          if (!span) return;
          const route = req.route?.path ?? req.originalUrl?.split('?')[0];
          if (route) {
            span.updateName(`${req.method} ${route}`);
          }
        } catch { /* noop */ }
      });
      next();
    });
  }

  // Closure for re-use in /internal/reload
  const reloadFeatures = async (): Promise<void> => {
    const config = await configService.load();
    if (!config) return;

    // Load features from config.installed.features
    for (const featureId of config.installed.features) {
      await loadFeature(featureId, app, nc, manager, configService, reloadFeatures);
    }

    // Also scan /data/features/ for installed features (added by hub install)
    const dataFeaturesDir = path.join(DATA_DIR, 'features');
    if (fs.existsSync(dataFeaturesDir)) {
      for (const entry of fs.readdirSync(dataFeaturesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        await loadFeature(entry.name, app, nc, manager, configService, reloadFeatures);
      }
    }

    // Scan /data/agents/ and start any new agents
    const dataAgentsDir = path.join(DATA_DIR, 'agents');
    if (fs.existsSync(dataAgentsDir)) {
      const { loadAgents } = await import('./agent-registry.js');
      const installedAgents = loadAgents(dataAgentsDir);
      for (const agent of installedAgents) {
        if (!manager.getStates().find(s => s.agentId === agent.manifest.id)) {
          await ensureConsumer(nc, 'AGENTS', agent.manifest.id, agent.manifest.subscribe_topics);
          await manager.startAgent(agent);
        }
      }
    }

    // Also scan /data/teams/*/agents/ and start team agents
    const dataTeamsDir = path.join(DATA_DIR, 'teams');
    if (fs.existsSync(dataTeamsDir)) {
      const { loadAgents: loadTeamAgents } = await import('./agent-registry.js');
      for (const teamEntry of fs.readdirSync(dataTeamsDir, { withFileTypes: true })) {
        if (!teamEntry.isDirectory()) continue;
        const teamAgentsDir = path.join(dataTeamsDir, teamEntry.name, 'agents');
        if (!fs.existsSync(teamAgentsDir)) continue;
        const teamAgents = loadTeamAgents(teamAgentsDir);
        for (const agent of teamAgents) {
          if (!manager.getStates().find(s => s.agentId === agent.manifest.id)) {
            await ensureConsumer(nc, 'AGENTS', agent.manifest.id, agent.manifest.subscribe_topics);
            await manager.startAgent(agent);
          }
        }
      }
    }
  };

  // ── Plugin list registered FIRST — must not be overridden by team plugins ──

  app.get('/api/plugins', async (_req: Request, res: Response) => {
    try {
      const plugins = await getPluginList(app);
      res.json(plugins);
    } catch (err) {
      logger.error({ err }, 'GET /api/plugins error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Core health endpoint ──────────────────────────────────────────────────

  app.get('/api/health', (_req: Request, res: Response) => {
    try {
      const agents = manager.getStates();
      res.json({
        status: 'ok',
        setupMode: opts.setupMode,
        agents,
        ts: Date.now(),
      });
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

  // ── Tickets REST API ─────────────────────────────────────────────────────

  app.get('/api/tickets', (req: Request, res: Response) => {
    try {
      const { status, priority, assigned_to } = req.query as Record<string, string | undefined>;
      const tickets = listTickets({ status, priority, assigned_to });
      res.json(tickets);
    } catch (err) {
      logger.error({ err }, 'GET /api/tickets error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/tickets', (req: Request, res: Response) => {
    try {
      const { title, status, priority, type, parent_id, blocked_by, author, assigned_to, labels, body, model_hint } =
        req.body as {
          title?: string;
          status?: TicketStatus;
          priority?: TicketPriority;
          type?: TicketType;
          parent_id?: string;
          blocked_by?: string;
          author?: string;
          assigned_to?: string;
          labels?: string;
          body?: string;
          model_hint?: string;
        };
      if (!title) return res.status(400).json({ error: '"title" is required' });
      const ticket = createTicket({ title, status, priority, type, parent_id, blocked_by, author, assigned_to, labels, body, model_hint });
      emitSseEvent('ticket_created', { ticket });
      res.status(201).json(ticket);
    } catch (err) {
      logger.error({ err }, 'POST /api/tickets error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/tickets/:id', (req: Request, res: Response) => {
    try {
      const ticket = getTicket(req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      res.json(ticket);
    } catch (err) {
      logger.error({ err }, 'GET /api/tickets/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.patch('/api/tickets/:id', (req: Request, res: Response) => {
    try {
      const ticket = getTicket(req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      const updated = updateTicket(req.params.id, req.body as Parameters<typeof updateTicket>[1], req.body.changed_by);
      if (!updated) return res.status(404).json({ error: 'Ticket not found' });
      emitSseEvent('ticket_updated', { ticket: updated });
      res.json(updated);
    } catch (err) {
      if (err instanceof Error && err.message.includes('CHECK constraint')) {
        return res.status(400).json({ error: 'Invalid field value', detail: err.message });
      }
      logger.error({ err }, 'PATCH /api/tickets/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/tickets/:id/comments', (req: Request, res: Response) => {
    try {
      const ticket = getTicket(req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      res.json(listComments(req.params.id));
    } catch (err) {
      logger.error({ err }, 'GET /api/tickets/:id/comments error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/tickets/:id/comments', (req: Request, res: Response) => {
    try {
      const ticket = getTicket(req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      const { author, body } = req.body as { author?: string; body?: string };
      if (!author || !body) return res.status(400).json({ error: '"author" and "body" are required' });
      const comment = addComment(req.params.id, author, body);
      res.status(201).json(comment);
    } catch (err) {
      logger.error({ err }, 'POST /api/tickets/:id/comments error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Chat with settings agent (NATS bridge) ────────────────────────────────

  app.post('/api/chat/settings', async (req: Request, res: Response) => {
    const { message, sessionId } = req.body as { message?: string; sessionId?: string };
    if (!message) return res.status(400).json({ error: '"message" required' });

    const sid = sessionId ?? 'default';
    const replySubject = `chat.reply.${sid}.${Date.now()}`;

    try {
      const sub = nc.subscribe(replySubject, { max: 1, timeout: 30_000 });

      // Use JetStream publish (traced) so chat messages appear in observability
      await publish(nc, 'agent.settings.inbox',
        JSON.stringify({ content: message, sessionId: sid, replySubject }),
      );

      for await (const msg of sub) {
        const data = JSON.parse(codec.decode(msg.data)) as unknown;
        res.json({ reply: data });
        break;
      }
    } catch (err) {
      logger.error({ err }, 'Chat settings error');
      res.status(503).json({ error: 'Settings agent not responding', detail: String(err) });
    }
  });

  // ── Internal reload (called by setup_complete MCP tool) ───────────────────

  app.post('/internal/reload', async (_req: Request, res: Response) => {
    try {
      await reloadFeatures();
      await loadTeamPlugins(app, nc, manager, configService, reloadFeatures);
      const plugins = await getPluginList();
      emitSseEvent('system', { type: 'plugins-updated', plugins });
      logger.info('Live reload completed');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Live reload failed');
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Static files for features (must be before catch-all) ────────────────────
  app.use('/features/settings', express.static(path.join(FEATURES_DIR, 'settings')));
  app.use('/features/simple-chat', express.static(path.join(FEATURES_DIR, 'simple-chat')));
  app.use('/features/observability', express.static(path.join(FEATURES_DIR, 'observability')));
  app.use('/features/data', express.static(path.join(DATA_DIR, 'features')));

  // ── Load features and team plugins (after core API routes) ──────────────────
  await loadFeature('settings', app, nc, manager, configService, reloadFeatures);
  await loadFeature('simple-chat', app, nc, manager, configService, reloadFeatures);
  await loadFeature('observability', app, nc, manager, configService, reloadFeatures);

  if (opts.setupMode === 'ready') {
    await reloadFeatures();
    await loadTeamPlugins(app, nc, manager, configService, reloadFeatures);
  }

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

export async function startApiServer(
  manager: AgentManager,
  nc: NatsConnection,
  configService: ConfigService,
  opts: { setupMode: SetupMode },
): Promise<void> {
  const app = await createApiApp(manager, nc, configService, opts);

  await new Promise<void>((resolve) => {
    app.listen(API_PORT, () => {
      logger.info({ port: API_PORT }, 'API server listening');
      resolve();
    });
  });
}
