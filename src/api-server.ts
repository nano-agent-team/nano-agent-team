/**
 * API Server — Express HTTP core
 *
 * Built-in routes (core):
 *   GET  /api/health        — agent statuses
 *   GET  /api/events        — SSE stream
 *   POST /api/chat/settings — NATS bridge for settings agent
 *   POST /internal/reload   — live reload tools after setup_complete
 *   POST /internal/restart  — graceful restart with pending-deploy tracking
 *   GET  /                  — static dashboard/dist/
 *
 * Plugin routes are registered via loadTool() from features/{id}/plugin.mjs
 * and via loadWorkflowPlugins() from agents/{id}/plugin.mjs (legacy).
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import express, { type Request, type Response, type NextFunction } from 'express';
import { StringCodec, type NatsConnection } from 'nats';

import { API_PORT, AGENTS_DIR, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { publish, ensureConsumer } from './nats-client.js';
import { isTracingEnabled } from './tracing/init.js';
import type { AgentManager } from './agent-manager.js';
import type { ConfigService } from './config-service.js';
import { detectSetupMode, type SetupMode } from './setup-detector.js';
import type { McpManager } from './mcp-manager.js';
import type { McpGateway } from './mcp-gateway.js';
import type { WorkspaceProvider } from './workspace-provider.js';
import { listTickets, getTicket, addComment, listComments, type TicketPriority, type TicketType } from './db.js';
import { getSoulState, readJournal } from './soul-state.js';
import { TicketRegistry } from './tickets/registry.js';
import { LocalTicketProvider } from './tickets/local-provider.js';
import type { AbstractStatus, TicketPriority as TP } from './tickets/types.js';
import { resolveTopicsForAgent, getInstanceId } from './agent-registry.js';
import type { WorkflowManifest } from './agent-registry.js';
import { loadWorkflow, expandInstances } from './workflow-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codec = StringCodec();

// ─── Tool / Plugin interface ───────────────────────────────────────────────────

interface PluginRoute { path: string; component: string; nav?: { label: string; icon: string } }
interface PluginInfo {
  id: string;
  name: string;
  uiEntry: string | null;
  routes: PluginRoute[];
}

/** Plugin interface for tools and workflow plugins */
export interface ToolPlugin {
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

/** Backward-compat alias */
export type TeamPlugin = ToolPlugin;

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

// ─── Tool loader ──────────────────────────────────────────────────────────────

const loadedTools = new Map<string, boolean>();
const TOOLS_DIR = path.join(__dirname, '..', 'features');

/**
 * Load a tool (formerly "feature") plugin.
 * Reads tool.json first, falls back to feature.json for backward compat.
 */
export async function loadTool(
  toolId: string,
  app: express.Application,
  nc: NatsConnection,
  manager: AgentManager,
  configService: ConfigService,
  reloadFeatures: () => Promise<void>,
): Promise<void> {
  if (loadedTools.has(toolId)) return;

  // Resolve tool path: built-in tools dir first, then installed tools in /data/features/
  const builtinPath = path.join(TOOLS_DIR, toolId);
  const installedPath = path.join(DATA_DIR, 'features', toolId);

  // Read tool.json first (new name), fall back to feature.json (compat)
  const builtinHasTool = fs.existsSync(path.join(builtinPath, 'tool.json'));
  const builtinHasFeature = fs.existsSync(path.join(builtinPath, 'feature.json'));
  const toolPath = (builtinHasTool || builtinHasFeature) ? builtinPath : installedPath;

  const toolJsonPath = fs.existsSync(path.join(toolPath, 'tool.json'))
    ? path.join(toolPath, 'tool.json')
    : path.join(toolPath, 'feature.json');

  if (!fs.existsSync(toolJsonPath)) {
    logger.warn({ toolId, toolPath }, 'Tool not found — skipping');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(toolJsonPath, 'utf8')) as {
    plugin: string;
    id: string;
  };
  const pluginPath = path.join(toolPath, manifest.plugin);

  try {
    logger.info({ toolId, pluginPath }, 'Loading tool');
    // ?v= cache-buster forces Node to re-evaluate the module on each reload call.
    const mod = await import(`${pluginPath}?v=${Date.now()}`) as { default?: ToolPlugin } | ToolPlugin;
    const plugin = ('default' in mod ? mod.default : mod) as ToolPlugin | undefined;

    if (plugin && typeof plugin.register === 'function') {
      await plugin.register(app, nc, manager, {
        emitSseEvent,
        publishNats: async (subject, payload) => { await publish(nc, subject, payload); },
        dataDir: DATA_DIR,
        configService,
        reloadFeatures,
      });
      loadedTools.set(toolId, true);
      logger.info({ toolId }, 'Tool loaded');
    } else {
      logger.warn({ toolId }, 'Tool plugin has no register() — skipping');
    }
  } catch (err) {
    logger.error({ err, toolId }, 'Failed to load tool');
  }
}

/** Backward-compat alias */
export const loadFeature = loadTool;

// ─── Workflow plugin loader ────────────────────────────────────────────────────
// Scans for plugin.mjs in:
//   1. AGENTS_DIR/*/plugin.mjs (built-in agents)
//   2. DATA_DIR/teams/*/agents/plugin.mjs (installed teams)

async function loadWorkflowPlugins(
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

  // Ensure team plugins can resolve packages installed in the app container.
  // ESM bare-specifier resolution walks up from the plugin file's location.
  // Symlinking /data/node_modules → /app/node_modules makes all app deps
  // available to any plugin loaded from /data/.
  const dataNmLink = path.join(DATA_DIR, 'node_modules');
  if (!fs.existsSync(dataNmLink)) {
    try { fs.symlinkSync('/app/node_modules', dataNmLink); } catch { /* ignore */ }
  }

  // 2. Installed teams in DATA_DIR/teams/*/
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
      logger.info({ plugin: pluginPath }, 'Loading workflow plugin');
      const mod = await import(`${pluginPath}?v=${Date.now()}`) as { default?: ToolPlugin } | ToolPlugin;
      const plugin = ('default' in mod ? mod.default : mod) as ToolPlugin | undefined;

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
        logger.info({ plugin: pluginPath }, 'Workflow plugin registered');
      } else {
        logger.warn({ plugin: pluginPath }, 'Plugin has no register() — skipping');
      }
    } catch (err) {
      logger.error({ err, plugin: pluginPath }, 'Failed to load workflow plugin');
    }
  }
}

/** Backward-compat alias */
const loadTeamPlugins = loadWorkflowPlugins;

// ─── Plugin list for dashboard ────────────────────────────────────────────────

const mountedStatic = new Set<string>();
const externalPlugins: PluginInfo[] = [];

async function getPluginList(app?: express.Application): Promise<PluginInfo[]> {
  const list: PluginInfo[] = [];

  function scanDir(dir: string, urlPrefix: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Read tool.json first (new name), fall back to feature.json (compat)
      const toolJsonPath = path.join(dir, entry.name, 'tool.json');
      const featureJsonPath = path.join(dir, entry.name, 'feature.json');
      const manifestPath = fs.existsSync(toolJsonPath) ? toolJsonPath : featureJsonPath;
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          id: string; name: string;
          frontend?: { remote: string; routes?: PluginRoute[] };
        };
        const remotePath = manifest.frontend?.remote
          ? path.join(dir, entry.name, manifest.frontend.remote)
          : null;
        const uiEntry = remotePath && fs.existsSync(remotePath)
          ? `${urlPrefix}/${entry.name}/${manifest.frontend!.remote}`
          : null;

        // Mount static files for this tool if not already done
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

  scanDir(TOOLS_DIR, '/features');
  scanDir(path.join(DATA_DIR, 'features'), '/features/data');

  // Add plugins registered by workflow plugins via registerPlugin()
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
  opts: { setupMode: SetupMode; mcpManager?: McpManager; mcpGateway?: McpGateway; ticketRegistry?: TicketRegistry; workspaceProvider?: WorkspaceProvider; secretManager?: import('./secret-manager.js').SecretManager },
): Promise<express.Application> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── Ticket registry ───────────────────────────────────────────────────────
  // Use injected registry (with GH proxy) or fallback to local-only
  const ticketRegistry = opts.ticketRegistry ?? (() => {
    const r = new TicketRegistry(nc);
    r.registerGlobal(new LocalTicketProvider());
    return r;
  })();

  // OTel span enrichment — give spans meaningful names after Express routing
  if (isTracingEnabled()) {
    app.use((req, _res, next) => {
      try {
        const otelApi = (globalThis as Record<string, unknown>).__otelApi as typeof import('@opentelemetry/api') | undefined;
        if (otelApi) {
          const span = otelApi.trace.getActiveSpan();
          if (span) {
            span.setAttribute('http.target', req.url);
          }
        }
      } catch { /* noop */ }
      next();
    });

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

  // Current workflow manifest — updated each time reloadFeatures() runs
  let currentWorkflow: WorkflowManifest | null = null;

  // Closure for re-use in /internal/reload
  const reloadFeatures = async (): Promise<void> => {
    const config = await configService.load();
    if (!config) return;

    // Load tools from config.installed.tools and config.installed.features (compat)
    const toolIds = new Set<string>([
      ...(config.installed.features ?? []),
      ...((config.installed as { tools?: string[] }).tools ?? []),
    ]);
    for (const toolId of toolIds) {
      await loadTool(toolId, app, nc, manager, configService, reloadFeatures);
    }

    // Also scan /data/features/ for installed tools (added by hub install)
    const dataFeaturesDir = path.join(DATA_DIR, 'features');
    if (fs.existsSync(dataFeaturesDir)) {
      for (const entry of fs.readdirSync(dataFeaturesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        await loadTool(entry.name, app, nc, manager, configService, reloadFeatures);
      }
    }

    // Start any built-in agents (AGENTS_DIR) not yet running
    const { loadAgents } = await import('./agent-registry.js');
    const builtinAgents = loadAgents(AGENTS_DIR);
    for (const agent of builtinAgents) {
      if (agent.manifest.id === 'settings') continue; // already running
      if (!manager.getStates().find(s => s.agentId === agent.manifest.id)) {
        const topics = resolveTopicsForAgent(agent.manifest, agent.binding);
        await ensureConsumer(nc, 'AGENTS', agent.manifest.id, topics);
        await manager.startAgent(agent);
      }
    }

    // Collect agent IDs managed by teams — root scan must skip these so that
    // team scan can start them with proper teamId context (for correct container naming).
    const dataTeamsDir = path.join(DATA_DIR, 'teams');
    const dataAgentsDir = path.join(DATA_DIR, 'agents');
    const teamManagedAgentIds = new Set<string>();
    if (fs.existsSync(dataTeamsDir)) {
      for (const teamEntry of fs.readdirSync(dataTeamsDir, { withFileTypes: true })) {
        if (!teamEntry.isDirectory()) continue;
        const teamJsonPath = path.join(dataTeamsDir, teamEntry.name, 'team.json');
        if (!fs.existsSync(teamJsonPath)) continue;
        try {
          const team = JSON.parse(fs.readFileSync(teamJsonPath, 'utf8')) as { agents?: string[] };
          if (Array.isArray(team.agents)) {
            for (const agentId of team.agents) teamManagedAgentIds.add(agentId);
          }
        } catch { /* ignore malformed team.json */ }
      }
    }

    // Scan /data/agents/ — skip agents managed by a team (they start in team scan with teamId)
    if (fs.existsSync(dataAgentsDir)) {
      const installedAgents = loadAgents(dataAgentsDir);
      for (const agent of installedAgents) {
        if (teamManagedAgentIds.has(agent.manifest.id)) continue;
        if (!manager.getStates().find(s => s.agentId === agent.manifest.id)) {
          const topics = resolveTopicsForAgent(agent.manifest, agent.binding);
          await ensureConsumer(nc, 'AGENTS', agent.manifest.id, topics);
          await manager.startAgent(agent);
        }
      }
    }

    // Track desired route keys so stale ones can be unregistered after the loop
    const desiredRoutes = new Set<string>();

    // Scan /data/teams/*/ — expand instances from workflow.json (multi-instance + dispatch support).
    // Falls back to team.json agents list when no workflow.json instances block is present.
    if (fs.existsSync(dataTeamsDir)) {
      for (const teamEntry of fs.readdirSync(dataTeamsDir, { withFileTypes: true })) {
        if (!teamEntry.isDirectory()) continue;
        const teamDir = path.join(dataTeamsDir, teamEntry.name);
        const teamAgentsDir = path.join(teamDir, 'agents');

        // Load workflow for this team (workflow.json → team.json fallback)
        const workflow = loadWorkflow(teamDir);
        currentWorkflow = workflow;

        // Expand instances: workflow.instances block (if present) or fallback to agents list
        const instances = workflow
          ? expandInstances(workflow, teamAgentsDir, dataAgentsDir)
          : [];

        // If no workflow, fall back to legacy team agent loading with root fallback
        if (!workflow) {
          const { loadTeamAgentsWithFallback } = await import('./agent-registry.js');
          const legacyAgents = loadTeamAgentsWithFallback(teamEntry.name, teamDir, dataAgentsDir);
          instances.push(...legacyAgents);
        }

        for (const agent of instances) {
          const instanceId = getInstanceId(agent);
          const consumerName = agent.consumerName ?? instanceId;
          const existing = manager.getStates().find(s => s.agentId === instanceId);
          // Always update consumer topics (handles workflow binding changes for running agents)
          const topics = resolveTopicsForAgent(agent.manifest, agent.binding, instanceId);
          await ensureConsumer(nc, 'AGENTS', consumerName, topics);
          if (!existing || existing.status === 'dead') {
            // Dead agents (max restarts reached) are reset and restarted on explicit reload
            if (existing?.status === 'dead') {
              manager.removeFromStates(instanceId);
            }
            await manager.startAgent(agent);
          }
        }

        // Register non-broadcast dispatch rules
        if (workflow?.dispatch) {
          for (const [subject, dispatchConfig] of Object.entries(workflow.dispatch)) {
            if (dispatchConfig.strategy !== 'broadcast') {
              await manager.registerDispatch(subject, dispatchConfig);
              desiredRoutes.add(`dispatch:${subject}`);
            }
          }
        }

        // Register entrypoint routes for { from, to } binding inputs
        // Dispatcher bridges external topic → agent.{instanceId}.{portName}
        for (const agent of instances) {
          const instanceId = getInstanceId(agent);
          for (const input of Object.values(agent.binding?.inputs ?? {})) {
            if (typeof input === 'object' && 'from' in input && 'to' in input) {
              await manager.registerEntrypointRoute(input.from, `agent.${instanceId}.${input.to}`);
              desiredRoutes.add(`${input.from}=>agent.${instanceId}.${input.to}`);
            }
          }
        }
      }
    }

    // Remove stale routes that are active but no longer in desired config
    for (const activeKey of manager.activeDispatcherRoutes) {
      if (!desiredRoutes.has(activeKey)) {
        if (activeKey.startsWith('dispatch:')) {
          await manager.unregisterDispatch(activeKey.replace('dispatch:', ''));
        } else {
          const arrowIdx = activeKey.indexOf('=>');
          if (arrowIdx !== -1) {
            const from = activeKey.slice(0, arrowIdx);
            const toSubject = activeKey.slice(arrowIdx + 2);
            await manager.unregisterEntrypointRoute(from, toSubject);
          }
        }
      }
    }

    // Load workflow plugins (routes registered by installed teams)
    await loadWorkflowPlugins(app, nc, manager, configService, reloadFeatures);
  };

  // ── Plugin list registered FIRST — must not be overridden by workflow plugins ──

  app.get('/api/plugins', async (_req: Request, res: Response) => {
    try {
      const plugins = await getPluginList(app);
      res.json(plugins);
    } catch (err) {
      logger.error({ err }, 'GET /api/plugins error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Dynamic setup mode detection ─────────────────────────────────────────
  // Setup mode is re-read from config on every request so it reflects
  // changes made by setup_complete MCP tool without requiring a restart.
  const getCurrentSetupMode = async (): Promise<SetupMode> => {
    return detectSetupMode(configService);
  };

  // ── Core health endpoint ──────────────────────────────────────────────────

  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      const agents = manager.getStates();
      res.json({
        status: 'ok',
        setupMode: await getCurrentSetupMode(),
        agents,
        ts: Date.now(),
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/health error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Workflow endpoint ─────────────────────────────────────────────────────

  app.get('/api/workflow', (_req: Request, res: Response) => {
    res.json({ workflow: currentWorkflow });
  });

  // ── Agent config endpoints ────────────────────────────────────────────────

  /** Validate agentId to prevent path traversal — only lowercase alphanumeric + hyphens allowed */
  function isValidAgentId(id: string): boolean {
    return /^[a-z0-9-]+$/.test(id);
  }

  /** Simple per-agent restart cooldown (10s) to prevent accidental DoS */
  const restartCooldowns = new Map<string, number>();
  const RESTART_COOLDOWN_MS = 10_000;

  app.get('/api/agents/:agentId/config', async (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });

      const agent = manager.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const claudeMdPath = path.join(agent.dir, 'CLAUDE.md');
      const baseInstructions = fs.existsSync(claudeMdPath)
        ? fs.readFileSync(claudeMdPath, 'utf8')
        : '';

      const customInstructionsPath = path.join(DATA_DIR, 'vault', 'agents', `${agentId}.md`);
      const customInstructions = fs.existsSync(customInstructionsPath)
        ? fs.readFileSync(customInstructionsPath, 'utf8')
        : null;

      const customConfigPath = path.join(DATA_DIR, 'vault', 'agents', `${agentId}.json`);
      let customConfig: { model?: string } = {};
      if (fs.existsSync(customConfigPath)) {
        try { customConfig = JSON.parse(fs.readFileSync(customConfigPath, 'utf8')); } catch { /* ignore */ }
      }

      res.json({ manifest: agent.manifest, baseInstructions, customInstructions, customConfig });
    } catch (err) {
      logger.error({ err }, 'GET /api/agents/:agentId/config error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.put('/api/agents/:agentId/config', (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });

      const agent = manager.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const { customInstructions, customConfig } = req.body as {
        customInstructions?: string;
        customConfig?: { model?: string };
      };

      // Validate model name format if provided
      if (customConfig?.model !== undefined && customConfig.model !== '') {
        if (typeof customConfig.model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(customConfig.model)) {
          return res.status(400).json({ error: 'Invalid model name format' });
        }
      }

      if (customInstructions !== undefined) {
        if (typeof customInstructions !== 'string') {
          return res.status(400).json({ error: 'customInstructions must be a string' });
        }
        if (customInstructions.length > 10_000) {
          return res.status(400).json({ error: 'customInstructions exceeds 10KB limit' });
        }
      }

      const vaultAgentsDir = path.join(DATA_DIR, 'vault', 'agents');
      fs.mkdirSync(vaultAgentsDir, { recursive: true });

      if (customInstructions !== undefined) {
        fs.writeFileSync(path.join(vaultAgentsDir, `${agentId}.md`), customInstructions, 'utf8');
      }
      if (customConfig !== undefined) {
        fs.writeFileSync(path.join(vaultAgentsDir, `${agentId}.json`), JSON.stringify(customConfig, null, 2), 'utf8');
      }

      // Phase 4: Hot-reload — notify running agent via core NATS (no restart needed)
      const configUpdate: Record<string, unknown> = {};
      if (customConfig?.model !== undefined) configUpdate.model = customConfig.model;
      if (customInstructions !== undefined) configUpdate.systemPrompt = customInstructions;

      if (Object.keys(configUpdate).length > 0) {
        try {
          nc.publish(`agent.${agentId}.config`, codec.encode(JSON.stringify(configUpdate)));
          logger.debug({ agentId }, 'Config update published to running agent');
        } catch { /* agent may not be running — vault persists for next start */ }
      }

      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'PUT /api/agents/:agentId/config error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/agents/:agentId/restart', async (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });

      const agent = manager.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const lastRestart = restartCooldowns.get(agentId) ?? 0;
      if (Date.now() - lastRestart < RESTART_COOLDOWN_MS) {
        return res.status(429).json({ error: 'Restart cooldown active, please wait' });
      }
      restartCooldowns.set(agentId, Date.now());

      await manager.restartAgent(agentId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'POST /api/agents/:agentId/restart error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Hot-reload: re-read manifest + recreate consumer + restart container ──

  app.post('/api/agents/:agentId/reload', async (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });

      const agent = manager.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const lastRestart = restartCooldowns.get(agentId) ?? 0;
      if (Date.now() - lastRestart < RESTART_COOLDOWN_MS) {
        return res.status(429).json({ error: 'Reload cooldown active, please wait' });
      }
      restartCooldowns.set(agentId, Date.now());

      await manager.reloadAgent(agentId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'POST /api/agents/:agentId/reload error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Phase 5: Zero-downtime deploy ─────────────────────────────────────────

  app.post('/api/agents/:agentId/deploy', async (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });

      const agent = manager.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // Kick off rollover in background — returns immediately
      void manager.rolloverAgent(agentId);
      res.json({ ok: true, message: 'Rollover started' });
    } catch (err) {
      logger.error({ err }, 'POST /api/agents/:agentId/deploy error');
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

  app.get('/api/tickets', async (req: Request, res: Response) => {
    try {
      const { status, priority, assigned_to } = req.query as Record<string, string | undefined>;
      const tickets = await ticketRegistry.listTickets({
        status: status as import('./tickets/types.js').AbstractStatus | undefined,
        priority: priority as TicketPriority | undefined,
        assignee: assigned_to,
      });
      res.json(tickets);
    } catch (err) {
      logger.error({ err }, 'GET /api/tickets error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/tickets', async (req: Request, res: Response) => {
    try {
      const { title, priority, type, parent_id, author, assigned_to, labels, body } =
        req.body as {
          title?: string;
          priority?: TicketPriority;
          type?: TicketType;
          parent_id?: string;
          author?: string;
          assigned_to?: string;
          labels?: string;
          body?: string;
        };
      const source_id = (req.body as Record<string, unknown>).source_id as string | undefined;
      if (!title) return res.status(400).json({ error: '"title" is required' });
      const ticket = await ticketRegistry.createTicket({
        title,
        body,
        priority,
        type,
        author,
        assignee: assigned_to,
        parentId: parent_id,
        labels: labels ? labels.split(',').map(l => l.trim()).filter(Boolean) : undefined,
        ...(source_id && { source_id }),
      });
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

  app.patch('/api/tickets/:id', async (req: Request, res: Response) => {
    try {
      const existing = getTicket(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Ticket not found' });

      const body = req.body as {
        title?: string; body?: string; status?: string; priority?: string;
        assigned_to?: string; labels?: string; changed_by?: string;
        expected_status?: string;
      };

      // Map snake_case API body → UpdateTicketData (abstract model)
      const updateData = {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.body !== undefined && { body: body.body }),
        ...(body.status !== undefined && { status: body.status as AbstractStatus }),
        ...(body.priority !== undefined && { priority: body.priority as TP }),
        ...(body.assigned_to !== undefined && { assignee: body.assigned_to }),
        ...(body.labels !== undefined && { labels: body.labels ? body.labels.split(',').map(l => l.trim()) : [] }),
        ...(body.expected_status !== undefined && { expected_status: body.expected_status as AbstractStatus }),
      };

      // registry.updateTicket fires NATS pipeline events on status transitions
      await ticketRegistry.updateTicket(req.params.id, updateData, body.changed_by);

      const updated = getTicket(req.params.id);
      if (!updated) return res.status(404).json({ error: 'Ticket not found' });
      emitSseEvent('ticket_updated', { ticket: updated });
      res.json(updated);
    } catch (err) {
      if (err instanceof Error && (err as any).statusCode === 409) {
        return res.status(409).json({ error: 'Status conflict', detail: err.message });
      }
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

  // ── Soul API ─────────────────────────────────────────────────────────────

  app.get('/api/soul/state', (req: Request, res: Response) => {
    try {
      const filters: { status?: string; since?: number } = {};
      if (req.query.status) filters.status = req.query.status as string;
      if (req.query.since) filters.since = parseInt(req.query.since as string);
      const state = getSoulState(DATA_DIR, filters);
      res.json(state);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(503).json({ error: 'obsidian_not_available' });
      } else {
        logger.error({ err }, 'Failed to get soul state');
        res.status(500).json({ error: 'internal_error' });
      }
    }
  });

  app.get('/api/soul/journal', (req: Request, res: Response) => {
    try {
      const date = req.query.date as string | undefined;
      const entries = readJournal(DATA_DIR, date);
      res.json(entries);
    } catch (err) {
      logger.error({ err }, 'Failed to read journal');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/api/soul/activity', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':\n\n'); // SSE comment — keeps connection alive

    // Subscribe to activity.> via NATS core (not JetStream)
    const sub = nc.subscribe('activity.>');
    const activityCodec = StringCodec();

    (async () => {
      for await (const msg of sub) {
        try {
          const data = activityCodec.decode(msg.data);
          res.write(`event: activity\ndata: ${data}\n\n`);
        } catch { /* connection closed */ }
      }
    })();

    req.on('close', () => {
      sub.unsubscribe();
    });
  });

  // ── Agent topology (for graph visualization) ─────────────────────────────
  app.get('/api/agents/topology', (_req: Request, res: Response) => {
    const agents = manager.getAllAgents().map(a => ({
      id: a.manifest.id,
      name: a.manifest.name ?? a.manifest.id,
      description: a.manifest.description ?? '',
      icon: (a.manifest as unknown as Record<string, unknown>).icon as string ?? '',
      status: a.status,
      subscribe_topics: a.manifest.subscribe_topics ?? [],
      outputs: (a.manifest.outputs ?? []).map((o: { port: string; subject?: string }) => ({
        port: o.port,
        subject: o.subject ?? '',
      })),
    }));

    // Build edges: output.subject of agent A matches subscribe_topic of agent B
    const edges: Array<{ from: string; to: string; subject: string; port: string }> = [];
    for (const src of agents) {
      for (const output of src.outputs) {
        if (!output.subject) continue;
        for (const dst of agents) {
          if (dst.id === src.id) continue;
          const matches = dst.subscribe_topics.some((topic: string) => {
            // Exact match or wildcard match (agent.*.task matches agent.foreman.task)
            if (topic === output.subject) return true;
            const regex = new RegExp('^' + topic.replace(/\./g, '\\.').replace(/\*/g, '[^.]+').replace(/>/g, '.+') + '$');
            return regex.test(output.subject);
          });
          if (matches) {
            edges.push({ from: src.id, to: dst.id, subject: output.subject, port: output.port });
          }
        }
      }
    }

    res.json({ agents, edges });
  });

  // ── Secrets API ─────────────────────────────────────────────────────────────
  if (opts.secretManager) {
    const sm = opts.secretManager;

    app.get('/api/secrets', (_req: Request, res: Response) => {
      const keys = sm.listKeys();
      const agents = manager.getAllAgents();
      const required: Record<string, string[]> = {};
      for (const a of agents) {
        const reqs = (a.manifest as unknown as Record<string, unknown>).required_env as string[] | undefined ?? [];
        if (reqs.length > 0) required[a.manifest.id] = reqs;
      }
      res.json({
        secrets: keys.map(k => ({ key: k, set: true })),
        required,
      });
    });

    app.post('/api/secrets', (req: Request, res: Response) => {
      const { key, value } = req.body ?? {};
      if (!key || !value) return res.status(400).json({ error: 'key and value required' });
      sm.set(key, value);
      res.json({ ok: true, key });
    });

    app.delete('/api/secrets/:key', (req: Request, res: Response) => {
      const key = req.params.key;
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) return res.status(400).json({ error: 'Invalid key' });
      sm.delete(key);
      res.json({ ok: true });
    });
  }

  // ── Chat Threads API ────────────────────────────────────────────────────────
  const CHAT_DIR = path.join(DATA_DIR, 'chat', 'threads');
  fs.mkdirSync(CHAT_DIR, { recursive: true });

  // Ensure main thread exists
  const mainThreadPath = path.join(CHAT_DIR, 'main.json');
  if (!fs.existsSync(mainThreadPath)) {
    fs.writeFileSync(mainThreadPath, JSON.stringify({
      id: 'main', title: 'General', messages: [], pending: false, createdAt: Date.now()
    }, null, 2));
  }

  const SAFE_THREAD_ID = /^[a-zA-Z0-9_-]+$/;

  function loadThread(id: string) {
    if (!SAFE_THREAD_ID.test(id)) return null;
    const p = path.join(CHAT_DIR, `${id}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  function saveThread(thread: Record<string, unknown>) {
    const id = thread.id as string;
    if (!SAFE_THREAD_ID.test(id)) throw new Error('Invalid thread ID');
    fs.writeFileSync(path.join(CHAT_DIR, `${id}.json`), JSON.stringify(thread, null, 2));
  }

  // List threads
  app.get('/api/chat/threads', (_req: Request, res: Response) => {
    const files = fs.readdirSync(CHAT_DIR).filter(f => f.endsWith('.json'));
    const threads = files.map(f => {
      const t = JSON.parse(fs.readFileSync(path.join(CHAT_DIR, f), 'utf8'));
      const msgs = t.messages ?? [];
      const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      return { id: t.id, title: t.title, pending: t.pending ?? false, lastMessage: last, messageCount: msgs.length };
    });
    res.json(threads);
  });

  // Get thread messages
  app.get('/api/chat/threads/:id/messages', (req: Request, res: Response) => {
    const thread = loadThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json(thread.messages ?? []);
  });

  // Send message to thread (proxies to chat-agent via NATS)
  app.post('/api/chat/threads/:id/messages', async (req: Request, res: Response) => {
    const { text } = req.body ?? {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const thread = loadThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    // Append user message
    thread.messages.push({ role: 'user', text, ts: Date.now() });
    saveThread(thread);

    // Send to chat-agent via NATS and collect response
    const replySubject = `chat.thread.reply.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sub = nc.subscribe(replySubject, { max: 1 });

    await publish(nc, 'agent.chat-agent.inbox', JSON.stringify({
      text,
      replySubject,
      threadId: thread.id,
    }));

    // Wait for reply with 60s timeout
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 60_000));
    const replyPromise = (async () => {
      for await (const msg of sub) {
        return JSON.parse(codec.decode(msg.data));
      }
      return null;
    })();

    const reply = await Promise.race([replyPromise, timeout]) as Record<string, unknown> | null;
    sub.unsubscribe();

    if (reply) {
      const replyText = (reply.result as string) ?? '';
      thread.messages.push({ role: 'agent', text: replyText, agentId: 'chat-agent', ts: Date.now() });
      if (thread.pending) (thread as Record<string, unknown>).pending = false;
      saveThread(thread);
      res.json({ ok: true, reply: replyText });
    } else {
      saveThread(thread);
      res.json({ ok: true, reply: '(timeout — agent is processing)' });
    }
  });

  // Create new thread
  app.post('/api/chat/threads', (req: Request, res: Response) => {
    const { title } = req.body ?? {};
    const id = `thread-${Date.now()}`;
    const thread = { id, title: title ?? 'New Thread', messages: [], pending: false, createdAt: Date.now() };
    saveThread(thread);
    res.json(thread);
  });

  // ── Per-agent activity SSE stream ─────────────────────────────────────────
  app.get('/api/agents/:agentId/stream', (req: Request, res: Response) => {
    const { agentId } = req.params;
    if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':\n\n');

    const sub = nc.subscribe(`activity.${agentId}`);
    const actCodec = StringCodec();

    (async () => {
      for await (const msg of sub) {
        try {
          const data = actCodec.decode(msg.data);
          res.write(`data: ${data}\n\n`);
        } catch { /* connection closed */ }
      }
    })();

    req.on('close', () => {
      sub.unsubscribe();
    });
  });

  // ── Chat with any agent (NATS bridge) ──────────────────────────────────────
  // Default: consciousness (user.message.inbound)
  // With ?agent=foreman: agent.foreman.inbox
  // With ?agent=strategist: agent.strategist.inbox

  app.post('/api/chat', async (req: Request, res: Response) => {
    const { message, sessionId, agent } = req.body as { message?: string; sessionId?: string; agent?: string };
    if (!message) return res.status(400).json({ error: '"message" required' });

    const sid = sessionId ?? 'default';
    const streamSubject = `chat.stream.${sid}.${Date.now()}`;

    // Resolve target NATS subject based on agent parameter
    const targetSubject = agent
      ? `agent.${agent}.inbox`
      : 'agent.chat-agent.inbox'; // default: chat agent

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const sse = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      (res as unknown as { flush?: () => void }).flush?.();
    };

    try {
      const sub = nc.subscribe(streamSubject);
      res.on('close', () => sub.unsubscribe());
      const timeoutHandle = setTimeout(() => sub.unsubscribe(), 300_000);

      logger.debug({ targetSubject, agent: agent ?? 'consciousness', streamSubject }, 'Chat: publishing');

      await publish(nc, targetSubject, JSON.stringify({
        text: message,
        sessionId: sid,
        streamSubject,
      }));

      for await (const msg of sub) {
        const event = JSON.parse(codec.decode(msg.data)) as { type: string; text?: string; error?: string };
        sse(event);
        if (event.type === 'done' || event.type === 'error') break;
      }

      clearTimeout(timeoutHandle);
    } catch (err) {
      logger.error({ err, agent: agent ?? 'consciousness' }, 'Chat error');
      sse({ type: 'error', error: `${agent ?? 'Consciousness'} not responding` });
    }
    res.end();
  });

  // ── Chat with settings agent (NATS bridge, setup mode) ────────────────────

  app.post('/api/chat/settings', async (req: Request, res: Response) => {
    const { message, sessionId } = req.body as { message?: string; sessionId?: string };
    if (!message) return res.status(400).json({ error: '"message" required' });

    const sid = sessionId ?? 'default';
    const replySubject = `chat.reply.${sid}.${Date.now()}`;

    // SSE stream — forwards real LLM tokens as they arrive from the agent runner
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const sse = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      (res as unknown as { flush?: () => void }).flush?.();
    };

    // streamSubject receives token-by-token chunks; replySubject is kept for fallback
    const streamSubject = `chat.stream.${sid}.${Date.now()}`;

    try {
      const sub = nc.subscribe(streamSubject);
      // Clean up subscription if client disconnects before done
      res.on('close', () => sub.unsubscribe());
      // Safety net: unsubscribe after 5 min even if agent never sends 'done'
      const timeoutHandle = setTimeout(() => sub.unsubscribe(), 300_000);

      logger.debug({ streamSubject }, 'Chat/settings: subscribed, publishing to agent');

      // Route chat to consciousness (primary user interface) instead of foreman
      await publish(nc, 'user.message.inbound', JSON.stringify({ text: message, sessionId: sid, replySubject, streamSubject }));

      logger.debug({ streamSubject }, 'Chat/settings: published, entering for-await');

      for await (const msg of sub) {
        const event = JSON.parse(codec.decode(msg.data)) as { type: string; text?: string; error?: string };
        logger.debug({ type: event.type }, 'Chat/settings: stream event received');
        sse(event);
        if (event.type === 'done' || event.type === 'error') break;
      }

      clearTimeout(timeoutHandle);
      logger.debug({ streamSubject }, 'Chat/settings: for-await exited');
    } catch (err) {
      logger.error({ err }, 'Chat settings error');
      sse({ type: 'error', error: 'Settings agent not responding' });
    }
    res.end();
  });

  // ── Internal reload (called by setup_complete MCP tool) ───────────────────

  // ── Internal management API (used by management MCP server in settings agent) ─
  // Restricted to localhost — not reachable from external network
  app.use('/internal', (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    res.status(403).json({ error: 'Forbidden' });
  });

  app.get('/internal/status', async (_req: Request, res: Response) => {
    try {
      res.json({
        setupMode: await getCurrentSetupMode(),
        agents: manager.getStates(),
        mcpServers: opts.mcpManager?.getStates() ?? [],
        ts: Date.now(),
      });
    } catch (err) {
      logger.error({ err }, 'GET /internal/status error');
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/internal/agents/:agentId/start', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      let agent = manager.getAgent(agentId);
      if (!agent) {
        // Agent not in manager memory — try loading from disk (freshly installed/created)
        const agentDir = path.join(DATA_DIR, 'agents', agentId);
        if (fs.existsSync(path.join(agentDir, 'manifest.json'))) {
          const { loadManifest } = await import('./agent-registry.js');
          const manifest = loadManifest(agentDir);
          agent = { manifest, dir: agentDir };
          const topics = resolveTopicsForAgent(manifest);
          await ensureConsumer(nc, 'AGENTS', manifest.id, topics);
          logger.info({ agentId }, 'Loading freshly installed agent from disk');
        } else {
          return res.status(404).json({ error: `Agent '${agentId}' not found` });
        }
      }
      await manager.startAgent(agent);
      res.json({ ok: true, agentId });
    } catch (err) {
      logger.error({ err }, 'POST /internal/agents/:agentId/start error');
      res.status(500).json({ error: String(err) });
    }
  });

  // Reload an agent: re-read manifest from disk, stop current container, start fresh.
  // Use after updating manifest.json (e.g. mcp_permissions changed).
  app.post('/internal/agents/:agentId/reload', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      const { loadManifest, findBindingForAgent } = await import('./agent-registry.js');
      const agentDir = path.join(DATA_DIR, 'agents', agentId);
      const manifest = loadManifest(agentDir);
      const binding = findBindingForAgent(agentId, path.join(DATA_DIR, 'teams'));
      const agent = { manifest, dir: agentDir, binding };
      const topics = resolveTopicsForAgent(manifest, binding);
      // Stop existing container if running
      if (manager.getAgent(agentId)) {
        await manager.stopAgent(agentId);
        await new Promise((r) => setTimeout(r, 500));
      }
      await ensureConsumer(nc, 'AGENTS', manifest.id, topics);
      await manager.startAgent(agent);
      logger.info({ agentId }, 'Agent reloaded from disk');
      res.json({ ok: true, agentId });
    } catch (err) {
      logger.error({ err }, 'POST /internal/agents/:agentId/reload error');
      res.status(500).json({ error: String(err) });
    }
  });

  // Send a NATS message to an agent's task subject (used to trigger agent workflows)
  app.post('/internal/agents/:agentId/send', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      const payload = JSON.stringify(req.body ?? {});
      const subject = `agent.${agentId}.task`;
      await publish(nc, subject, payload);
      res.json({ ok: true, subject, payloadLength: payload.length });
    } catch (err) {
      logger.error({ err }, 'POST /internal/agents/:agentId/send error');
      res.status(500).json({ error: String(err) });
    }
  });

  // Start a freshly installed agent from disk (not yet in manager memory)
  app.post('/internal/agents/:agentId/start-installed', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });

      // Skip if already running
      if (manager.getStates().find(s => s.agentId === agentId)) {
        return res.json({ ok: true, agentId, skipped: 'already running' });
      }

      const { loadManifest } = await import('./agent-registry.js');
      const agentDir = path.join(DATA_DIR, 'agents', agentId);
      const manifest = loadManifest(agentDir);
      const agent = { manifest, dir: agentDir };
      const topics = resolveTopicsForAgent(manifest);
      await ensureConsumer(nc, 'AGENTS', manifest.id, topics);
      await manager.startAgent(agent);
      logger.info({ agentId }, 'Installed agent started');
      res.json({ ok: true, agentId });
    } catch (err) {
      logger.error({ err }, 'POST /internal/agents/:agentId/start-installed error');
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/internal/agents/:agentId/stop', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      if (!isValidAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      await manager.stopAgent(agentId);
      res.json({ ok: true, agentId });
    } catch (err) {
      logger.error({ err }, 'POST /internal/agents/:agentId/stop error');
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/internal/mcp-servers/:serverId/restart', async (req: Request, res: Response) => {
    try {
      const { serverId } = req.params;
      if (!opts.mcpManager) return res.status(503).json({ error: 'MCP manager not available' });
      await opts.mcpManager.restart(serverId);
      // Invalidate gateway tool cache so tools are re-discovered from restarted container
      opts.mcpGateway?.invalidateCache(serverId);
      logger.info({ serverId }, 'MCP server restarted via internal API');
      res.json({ ok: true, serverId });
    } catch (err) {
      logger.error({ err }, 'POST /internal/mcp-servers/:serverId/restart error');
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Workspace management ──────────────────────────────────────────────────
  if (opts.workspaceProvider) {
    const wsp = opts.workspaceProvider;

    // IMPORTANT: by-owner route must be before /:id to avoid "by-owner" matching as ID
    app.get('/internal/workspaces/by-owner/:ownerId', (req: Request, res: Response) => {
      try {
        const ws = wsp.findByOwner(req.params.ownerId);
        if (!ws) return res.status(404).json({ error: 'No active workspace for owner' });
        res.json(ws);
      } catch (err) {
        logger.error({ err }, 'GET /internal/workspaces/by-owner/:ownerId error');
        res.status(500).json({ error: String(err) });
      }
    });

    app.post('/internal/workspaces', async (req: Request, res: Response) => {
      try {
        const { repoType, ownerId, branch } = req.body as { repoType: string; ownerId?: string; branch?: string };
        if (!repoType) return res.status(400).json({ error: 'repoType is required' });
        const ws = await wsp.create(repoType, ownerId ?? 'anonymous', branch);
        res.status(201).json(ws);
      } catch (err) {
        logger.error({ err }, 'POST /internal/workspaces error');
        res.status(500).json({ error: String(err) });
      }
    });

    app.get('/internal/workspaces', (_req: Request, res: Response) => {
      try {
        res.json(wsp.list());
      } catch (err) {
        logger.error({ err }, 'GET /internal/workspaces error');
        res.status(500).json({ error: String(err) });
      }
    });

    app.get('/internal/workspaces/:id', (req: Request, res: Response) => {
      try {
        const ws = wsp.get(req.params.id);
        if (!ws) return res.status(404).json({ error: 'Workspace not found' });
        res.json(ws);
      } catch (err) {
        logger.error({ err }, 'GET /internal/workspaces/:id error');
        res.status(500).json({ error: String(err) });
      }
    });

    app.delete('/internal/workspaces/:id', (req: Request, res: Response) => {
      try {
        wsp.returnWorkspace(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, 'DELETE /internal/workspaces/:id error');
        res.status(500).json({ error: String(err) });
      }
    });
  }

  app.post('/internal/reload', async (_req: Request, res: Response) => {
    try {
      await reloadFeatures(); // includes loadWorkflowPlugins
      const plugins = await getPluginList();
      emitSseEvent('system', { type: 'plugins-updated', plugins });
      logger.info('Live reload completed');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Live reload failed');
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Ephemeral freeze/status — used by release manager before deploy ──────

  app.post('/internal/ephemeral/freeze', (_req: Request, res: Response) => {
    manager.freezeEphemeral();
    res.json({ ok: true, frozen: true });
  });

  app.post('/internal/ephemeral/unfreeze', (_req: Request, res: Response) => {
    manager.unfreezeEphemeral();
    res.json({ ok: true, frozen: false });
  });

  app.get('/internal/ephemeral/status', (_req: Request, res: Response) => {
    res.json(manager.getEphemeralStatus());
  });

  // ── POST /internal/restart — graceful restart with deploy tracking ───────
  app.post('/internal/restart', async (req: Request, res: Response) => {
    try {
      const { ticket_id, workspaceId } = req.body ?? {};

      // Determine current main commit from bare repo (for rollback reference)
      let mainCommit = 'unknown';
      try {
        const bareRepoDir = path.join(DATA_DIR, 'workspaces', 'repos', 'nano-agent-team.git');
        mainCommit = execSync('git rev-parse main', { cwd: bareRepoDir, encoding: 'utf8' }).trim();
      } catch {
        logger.warn('Could not determine main commit from bare repo');
      }

      // Write pending-deploy.json with deploy context
      const pendingDeploy = {
        ticket_id: ticket_id ?? null,
        workspaceId: workspaceId ?? null,
        previousMainCommit: mainCommit,
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(DATA_DIR, 'pending-deploy.json'),
        JSON.stringify(pendingDeploy, null, 2),
      );
      logger.info({ pendingDeploy }, 'Pending deploy written, restart scheduled');

      // Respond before shutting down
      res.json({ ok: true, message: 'Restart scheduled' });

      // Graceful shutdown after a short delay to allow response to flush
      setTimeout(async () => {
        try {
          logger.info('Performing graceful shutdown for restart...');
          await manager.stopAll();
          await manager.stopAllDispatches();
          nc.drain().catch(() => {});
          // Close the HTTP server if available
          const httpServer = (app as unknown as { _httpServer?: http.Server })._httpServer;
          if (httpServer) {
            httpServer.close();
          }
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error during restart shutdown');
          process.exit(1);
        }
      }, 500);
    } catch (err) {
      logger.error({ err }, 'POST /internal/restart error');
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Static files for tools (must be before catch-all) ────────────────────
  app.use('/features/settings', express.static(path.join(TOOLS_DIR, 'settings')));
  app.use('/features/simple-chat', express.static(path.join(TOOLS_DIR, 'simple-chat')));
  app.use('/features/observability', express.static(path.join(TOOLS_DIR, 'observability')));
  app.use('/features/tickets', express.static(path.join(TOOLS_DIR, 'tickets')));
  app.use('/features/workflow-editor', express.static(path.join(TOOLS_DIR, 'workflow-editor')));
  app.use('/features/hello-world', express.static(path.join(TOOLS_DIR, 'hello-world')));
  app.use('/features/data', express.static(path.join(DATA_DIR, 'features')));

  // ── Load tools and workflow plugins (after core API routes) ──────────────
  await loadTool('settings', app, nc, manager, configService, reloadFeatures);
  await loadTool('simple-chat', app, nc, manager, configService, reloadFeatures);
  await loadTool('observability', app, nc, manager, configService, reloadFeatures);
  await loadTool('tickets', app, nc, manager, configService, reloadFeatures);
  await loadTool('workflow-editor', app, nc, manager, configService, reloadFeatures);
  await loadTool('hello-world', app, nc, manager, configService, reloadFeatures);

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
  opts: { setupMode: SetupMode; mcpManager?: McpManager; mcpGateway?: McpGateway; ticketRegistry?: TicketRegistry; workspaceProvider?: WorkspaceProvider; secretManager?: import('./secret-manager.js').SecretManager },
): Promise<http.Server> {
  const app = await createApiApp(manager, nc, configService, opts);

  // Subscribe to chat.push for proactive messages from chat agent → dashboard SSE + main thread
  const chatPushSub = nc.subscribe('chat.push');
  (async () => {
    for await (const msg of chatPushSub) {
      try {
        const data = JSON.parse(codec.decode(msg.data)) as { text?: string; from?: string };
        emitSseEvent('chat-push', data);
        // Also persist to main chat thread so messages appear in chat history
        if (data.text) {
          try {
            const chatDir = path.join(DATA_DIR, 'chat', 'threads');
            const mainPath = path.join(chatDir, 'main.json');
            if (fs.existsSync(mainPath)) {
              const thread = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
              thread.messages.push({ role: 'agent', text: data.text, agentId: data.from ?? 'system', ts: Date.now() });
              fs.writeFileSync(mainPath, JSON.stringify(thread, null, 2));
            }
          } catch { /* ignore */ }
        }
        logger.debug({ from: data.from }, 'Chat push message broadcast via SSE');
      } catch {
        logger.warn('Invalid chat.push payload');
      }
    }
  })();

  return new Promise<http.Server>((resolve) => {
    const server = app.listen(API_PORT, () => {
      logger.info({ port: API_PORT }, 'API server listening');
      // Expose server reference for /internal/restart shutdown
      (app as unknown as { _httpServer?: http.Server })._httpServer = server;
      resolve(server);
    });
  });
}
