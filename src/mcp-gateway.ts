/**
 * MCP Gateway — HTTP MCP server with per-agent ACL + MCP Federation
 *
 * Runs inside nate on a dedicated port (default: 3003).
 * Agent containers connect via: http://host.docker.internal:3003/mcp
 *
 * Each request carries X-Agent-ID header.
 *
 * Two layers of tooling:
 *
 * 1. Built-in tools (tickets, etc.)
 *    Controlled by manifest.mcp_permissions.
 *    Example: { "tickets": ["get", "list", "comment"] }
 *
 * 2. External MCP servers (via McpFederation)
 *    Controlled by manifest.mcp_access.
 *    Each external MCP server runs as a Docker container managed by McpManager.
 *    Tool calls are proxied to the appropriate container.
 *    Example: { "github": ["pr.read", "pr.comment"] }
 *
 * Permission examples (manifest.json):
 *   "mcp_permissions": { "tickets": ["get", "list", "comment", "approve"] }
 *   "mcp_access": { "github": ["pr.read", "pr.comment"] }
 */

import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { logger } from './logger.js';
import type { TicketRegistry } from './tickets/registry.js';
import type { AbstractStatus, TicketPriority, TicketType } from './tickets/types.js';
import type { McpManager } from './mcp-manager.js';
import type { McpServerRegistry } from './mcp-server-registry.js';

// ─── Gateway options (config/management tools) ────────────────────────────────

export interface GatewayOptions {
  dataDir: string;
  featuresDir: string;
  teamsDir: string;
  mcpServersDir: string;
  apiPort: string;
  hubUrl?: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type PermissionMap = Record<string, string[] | '*'>;

/** Called by gateway to resolve built-in permissions for a given agent ID */
type PermissionResolver = (agentId: string) => PermissionMap;

/** Called by gateway to resolve mcp_access (external MCP servers) for a given agent ID */
type McpAccessResolver = (agentId: string) => Record<string, string[] | '*'>;

interface ExternalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverUrl: string;
}

// ─── Built-in tool permissions ────────────────────────────────────────────────

const TICKET_TOOL_PERMISSIONS: Record<string, string> = {
  tickets_list:   'list',
  ticket_get:     'get',
  ticket_create:  'create',
  ticket_update:  'update',
  ticket_approve: 'approve',
  ticket_reject:  'reject',
  ticket_comment: 'comment',
};

function canCallBuiltin(permissions: PermissionMap, namespace: string, toolName: string): boolean {
  const ns = permissions[namespace];
  if (ns === undefined) return true; // no restriction → allow all
  if (ns === '*') return true;
  // For tickets namespace, use the short permission name (e.g. 'tickets_list' → 'list')
  // For all other namespaces, use the tool name directly as the permission string
  const required = TICKET_TOOL_PERMISSIONS[toolName] ?? toolName;
  return Array.isArray(ns) && (ns.includes(required) || ns.includes('*'));
}

// ─── External MCP federation ──────────────────────────────────────────────────

/**
 * Fetches tool list from an external MCP server container.
 * Uses JSON-RPC tools/list method.
 */
async function fetchToolsFromServer(serverUrl: string): Promise<Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}>> {
  try {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { result?: { tools?: unknown[] } };
    return (data.result?.tools ?? []) as Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
  } catch (err) {
    logger.warn({ err, serverUrl }, 'Failed to fetch tools from MCP server');
    return [];
  }
}

/**
 * Calls a tool on an external MCP server container and returns the result.
 */
async function callExternalTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const res = await fetch(`${serverUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`MCP server returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    result?: { content: Array<{ type: string; text: string }> };
    error?: { message: string };
  };

  if (data.error) throw new Error(data.error.message);
  return data.result ?? { content: [{ type: 'text', text: 'No result' }] };
}

// ─── McpServer builder (built-in tools only) ─────────────────────────────────

// ─── Config tool helpers ──────────────────────────────────────────────────────

function cfgLoad(configPath: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>; } catch { return {}; }
}
function cfgSave(configPath: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}
function cfgGetNested(obj: Record<string, unknown>, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) { if (cur == null || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k]; }
  return cur;
}
function cfgSetNested(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) { const k = keys[i]; if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k] as Record<string, unknown>; }
  cur[keys[keys.length - 1]] = value;
}
function cfgMaskSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
  const m = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  // Walk entire tree and mask any key that looks like a secret
  const maskKeys = new Set(['apiKey', 'token', 'secret', 'password', 'key']);
  const walk = (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      if (maskKeys.has(k) && v) { obj[k] = '***'; }
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>);
    }
  };
  walk(m);
  return m;
}
function cfgMissing(cfg: Record<string, unknown>): string[] {
  // OAuth/subscription users have primaryProvider set but no apiKey — that's valid
  if (cfg.primaryProvider) return [];
  const missing: string[] = [];
  const p = cfg.provider as Record<string, unknown> | undefined;
  if (!p?.apiKey) missing.push('provider.apiKey');
  return missing;
}
function cfgScanManifests(dir: string, filename: string): Array<{ id: string; name: string }> {
  if (!fs.existsSync(dir)) return [];
  const result: Array<{ id: string; name: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(dir, entry.name, filename);
    if (!fs.existsSync(p)) continue;
    try { const m = JSON.parse(fs.readFileSync(p, 'utf8')) as { id: string; name: string }; if (m.id !== 'settings') result.push({ id: m.id, name: m.name }); } catch { /* skip */ }
  }
  return result;
}
function cfgLoadSecrets(secretsPath: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as Record<string, string>; } catch { return {}; }
}
function cfgSaveSecrets(secretsPath: string, secrets: Record<string, string>): void {
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}
function cfgScanMcpServers(mcpServersDir: string): Array<{ id: string; required_secrets: string[] }> {
  if (!fs.existsSync(mcpServersDir)) return [];
  const result: Array<{ id: string; required_secrets: string[] }> = [];
  for (const entry of fs.readdirSync(mcpServersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(mcpServersDir, entry.name, 'manifest.json'), 'utf8')) as { id: string; required_secrets?: string[] };
      result.push({ id: m.id, required_secrets: m.required_secrets ?? [] });
    } catch { /* skip */ }
  }
  return result;
}

// ─── Hub helpers (management tools) ──────────────────────────────────────────

const HUB_DIR = '/tmp/hub';

function hubReadJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T; } catch { return null; }
}
function hubTeamRequiredSecrets(teamId: string): string[] {
  const teamDir = path.join(HUB_DIR, 'teams', teamId);
  const secrets = new Set<string>();
  const agentsDir = path.join(teamDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = hubReadJson<{ required_secrets?: string[]; mcp_access?: Record<string, string[] | '*'> }>(
        path.join(agentsDir, entry.name, 'manifest.json'),
      );
      if (!m) continue;
      m.required_secrets?.forEach((s) => secrets.add(s));
      if (m.mcp_access) {
        for (const serverId of Object.keys(m.mcp_access)) {
          const ms = hubReadJson<{ required_secrets?: string[] }>(
            path.join(HUB_DIR, 'mcp-servers', serverId, 'manifest.json'),
          );
          ms?.required_secrets?.forEach((s) => secrets.add(s));
        }
      }
    }
  }
  return [...secrets];
}

function buildMcpServer(
  registry: TicketRegistry,
  agentId: string,
  permissions: PermissionMap,
  opts?: GatewayOptions,
): McpServer {
  const server = new McpServer({ name: 'nano-agent-mcp-gateway', version: '1.0.0' });

  // ── Built-in: tickets ──────────────────────────────────────────────────────

  if (canCallBuiltin(permissions, 'tickets', 'tickets_list')) {
    server.tool(
      'tickets_list',
      'List tickets with optional filters. Returns id, title, status, priority, assignee.',
      {
        status:   z.string().optional().describe('Abstract status: new|approved|in_progress|review|done|rejected|pending_input'),
        priority: z.string().optional().describe('Priority: CRITICAL|HIGH|MED|LOW'),
        assignee: z.string().optional().describe('Filter by assignee agent id'),
      },
      async ({ status, priority, assignee }) => {
        const tickets = await registry.listTickets({
          status:   status as AbstractStatus | undefined,
          priority: priority as TicketPriority | undefined,
          assignee,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(tickets, null, 2) }] };
      },
    );
  }

  if (canCallBuiltin(permissions, 'tickets', 'ticket_get')) {
    server.tool(
      'ticket_get',
      'Get a single ticket with its comments.',
      { ticket_id: z.string().describe('Ticket ID (e.g. TICK-0001 or GH-42)') },
      async ({ ticket_id }) => {
        const ticket = await registry.getTicket(ticket_id);
        if (!ticket) return { content: [{ type: 'text' as const, text: `Ticket ${ticket_id} not found` }], isError: true };
        const comments = await registry.getComments(ticket_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ticket, comments }, null, 2) }] };
      },
    );
  }

  if (canCallBuiltin(permissions, 'tickets', 'ticket_create')) {
    server.tool(
      'ticket_create',
      'Create a new ticket. Use backend to explicitly target a tracker (e.g. "github", "local").',
      {
        title:    z.string().describe('Ticket title'),
        body:     z.string().optional().describe('Ticket description / tech spec'),
        priority: z.string().optional().describe('Priority: CRITICAL|HIGH|MED|LOW'),
        type:     z.string().optional().describe('Type: epic|story|task|bug|idea'),
        backend:  z.string().optional().describe('Explicit backend: "local" | "github" | "jira". Omit to use configured primary.'),
      },
      async ({ title, body, priority, type, backend }) => {
        const ticket = await registry.createTicket({
          title, body, backend,
          priority: priority as TicketPriority | undefined,
          type:     type as TicketType | undefined,
          author:   agentId,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
      },
    );
  }

  if (canCallBuiltin(permissions, 'tickets', 'ticket_update')) {
    server.tool(
      'ticket_update',
      'Update ticket fields. Pass status to transition: "in_progress" triggers Developer (spec-ready), "review" triggers Reviewer, "done" closes the ticket.',
      {
        ticket_id: z.string().describe('Ticket ID'),
        title:     z.string().optional().describe('New title'),
        body:      z.string().optional().describe('New body / tech spec (replaces existing)'),
        priority:  z.string().optional().describe('New priority: CRITICAL|HIGH|MED|LOW'),
        assignee:  z.string().optional().describe('New assignee agent id'),
        status:    z.string().optional().describe('New status: in_progress | review | done'),
      },
      async ({ ticket_id, title, body, priority, assignee, status }) => {
        const ticket = await registry.updateTicket(ticket_id, {
          title, body,
          priority: priority as TicketPriority | undefined,
          assignee,
          status: status as import('./tickets/types.js').AbstractStatus | undefined,
        }, agentId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
      },
    );
  }

  if (canCallBuiltin(permissions, 'tickets', 'ticket_approve')) {
    server.tool(
      'ticket_approve',
      'Approve a ticket. Transitions status to "approved" and triggers NATS pipeline event.',
      {
        ticket_id: z.string().describe('Ticket ID'),
        assignee:  z.string().optional().describe('Assign to this agent (e.g. "architect")'),
      },
      async ({ ticket_id, assignee }) => {
        const ticket = await registry.updateTicket(ticket_id, { status: 'approved', assignee }, agentId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
      },
    );
  }

  if (canCallBuiltin(permissions, 'tickets', 'ticket_reject')) {
    server.tool(
      'ticket_reject',
      'Reject a ticket. Transitions status to "rejected" and triggers NATS pipeline event.',
      { ticket_id: z.string().describe('Ticket ID') },
      async ({ ticket_id }) => {
        const ticket = await registry.updateTicket(ticket_id, { status: 'rejected' }, agentId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
      },
    );
  }

  if (canCallBuiltin(permissions, 'tickets', 'ticket_comment')) {
    server.tool(
      'ticket_comment',
      'Add a comment to a ticket.',
      {
        ticket_id: z.string().describe('Ticket ID'),
        body:      z.string().describe('Comment text'),
      },
      async ({ ticket_id, body }) => {
        const comment = await registry.addComment(ticket_id, body, agentId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(comment, null, 2) }] };
      },
    );
  }

  // ── Built-in: config (settings agent only) ───────────────────────────────────

  if (opts && permissions['config'] !== undefined) {
    const configPath = path.join(opts.dataDir, 'config.json');
    const secretsPath = path.join(opts.dataDir, 'secrets.json');

    if (canCallBuiltin(permissions, 'config', 'config_get'))
      server.tool('config_get', 'Read current config or a specific value (secrets masked).', { key: z.string().optional() }, async ({ key }) => {
        const cfg = cfgLoad(configPath);
        const value = key ? cfgGetNested(cfg, key.split('.')) : cfgMaskSecrets(cfg);
        return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
      });

    if (canCallBuiltin(permissions, 'config', 'config_set'))
      server.tool('config_set', 'Write a config value at a dot-path.', { key: z.string(), value: z.unknown() }, async ({ key, value }) => {
        const cfg = cfgLoad(configPath);
        cfgSetNested(cfg, key.split('.'), value);
        cfgSave(configPath, cfg);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, key }) }] };
      });

    if (canCallBuiltin(permissions, 'config', 'config_status'))
      server.tool('config_status', 'Check what is missing for setup to complete.', {}, async () => {
        const cfg = cfgLoad(configPath);
        const missing = cfgMissing(cfg);
        const setupCompleted = cfg.setupCompleted === true;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ complete: setupCompleted && missing.length === 0, setupCompleted, missing }) }] };
      });

    if (canCallBuiltin(permissions, 'config', 'setup_complete'))
      server.tool('setup_complete', 'Mark setup as done and trigger live reload.', { install: z.array(z.string()).optional() }, async ({ install }) => {
        const ids = install ?? [];
        const cfg = cfgLoad(configPath);
        const teams = ids.filter((id) => fs.existsSync(path.join(opts.teamsDir, id, 'team.json')));
        const features = ids.filter((id) => !teams.includes(id));
        cfg.setupCompleted = true;
        const installed = (cfg.installed as { features: string[]; teams: string[] } | undefined) ?? { features: [], teams: [] };
        installed.features = [...new Set([...installed.features, ...features])];
        installed.teams = [...new Set([...installed.teams, ...teams])];
        cfg.installed = installed;
        (cfg.meta as Record<string, unknown> | undefined ?? (cfg.meta = {}))['setupCompletedAt'] = new Date().toISOString();
        cfgSave(configPath, cfg);
        try { await fetch(`http://localhost:${opts.apiPort}/internal/reload`, { method: 'POST' }); } catch { /* best effort */ }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, installed }) }] };
      });

    if (canCallBuiltin(permissions, 'config', 'list_available'))
      server.tool('list_available', 'List installable teams and features.', {}, async () => {
        const teams = cfgScanManifests(opts.teamsDir, 'team.json');
        const features = cfgScanManifests(opts.featuresDir, 'feature.json');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ teams, features }) }] };
      });

    if (canCallBuiltin(permissions, 'config', 'list_secrets'))
      server.tool('list_secrets', 'List all secret keys and whether they are set (values never exposed).', {}, async () => {
        const secrets = cfgLoadSecrets(secretsPath);
        const mcpServers = cfgScanMcpServers(opts.mcpServersDir);
        const keys = Object.keys(secrets);
        const result = keys.map((k) => ({ key: k, is_set: true }));
        const known = new Set(keys);
        for (const srv of mcpServers) {
          for (const reqKey of srv.required_secrets) {
            if (!known.has(reqKey)) { result.push({ key: reqKey, is_set: false }); known.add(reqKey); }
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });

    if (canCallBuiltin(permissions, 'config', 'set_secret'))
      server.tool('set_secret', 'Store a secret value in data/secrets.json (mode 0600).', { key: z.string(), value: z.string() }, async ({ key, value }) => {
        const secrets = cfgLoadSecrets(secretsPath);
        secrets[key] = value;
        cfgSaveSecrets(secretsPath, secrets);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, key }) }] };
      });

    if (canCallBuiltin(permissions, 'config', 'check_secrets'))
      server.tool('check_secrets', 'Check which required secrets are missing for given MCP server IDs.', { server_ids: z.array(z.string()) }, async ({ server_ids }) => {
        const secrets = cfgLoadSecrets(secretsPath);
        const mcpServers = cfgScanMcpServers(opts.mcpServersDir);
        const result = server_ids.map((id) => {
          const srv = mcpServers.find((s) => s.id === id);
          if (!srv) return { server_id: id, missing: [], ready: false };
          const missing = srv.required_secrets.filter((k) => !secrets[k]);
          return { server_id: id, missing, ready: missing.length === 0 };
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
  }

  // ── Built-in: management (settings agent only) ────────────────────────────────

  if (opts && permissions['management'] !== undefined) {
    const apiBase = `http://localhost:${opts.apiPort}`;
    const configPath = path.join(opts.dataDir, 'config.json');
    const hubUrl = opts.hubUrl ?? 'https://github.com/nano-agent-team-dev/hub.git';

    async function callInternal(method: string, endpoint: string, body?: unknown): Promise<unknown> {
      const res = await fetch(`${apiBase}${endpoint}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`${method} ${endpoint} → ${res.status}: ${await res.text().catch(() => '')}`);
      return res.json();
    }

    server.tool('get_system_status', 'Get current system status: running agents, MCP servers, setup mode.', {}, async () => {
      const status = await callInternal('GET', '/internal/status');
      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] };
    });

    server.tool('start_agent', 'Start a stopped or dead agent by ID.', { agent_id: z.string() }, async ({ agent_id }) => {
      const result = await callInternal('POST', `/internal/agents/${agent_id}/start`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });

    server.tool('stop_agent', 'Stop a running agent by ID.', { agent_id: z.string() }, async ({ agent_id }) => {
      const result = await callInternal('POST', `/internal/agents/${agent_id}/stop`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });

    server.tool('restart_mcp_server', 'Restart an MCP server container (use after updating its secrets).', { server_id: z.string() }, async ({ server_id }) => {
      const result = await callInternal('POST', `/internal/mcp-servers/${server_id}/restart`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });

    server.tool('fetch_hub', 'Clone or update the hub catalog from git.', { url: z.string().optional() }, async ({ url }) => {
      const cloneUrl = (() => {
        const u = url ?? hubUrl;
        const ghToken = process.env.GH_TOKEN;
        return ghToken && u.includes('github.com') ? u.replace('https://', `https://oauth2:${ghToken}@`) : u;
      })();
      try {
        const gitEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', GIT_TERMINAL_PROMPT: '0' };
        // Check if existing clone matches the configured URL (re-clone if stale/wrong remote)
        const existingGit = path.join(HUB_DIR, '.git');
        if (fs.existsSync(existingGit)) {
          let existingRemote = '';
          try { existingRemote = execSync('git remote get-url origin', { cwd: HUB_DIR, env: gitEnv, encoding: 'utf8' }).trim(); } catch { /* no remote */ }
          const normalizeUrl = (u: string) => u.replace(/\/+$/, '');
          if (normalizeUrl(existingRemote) !== normalizeUrl(cloneUrl)) {
            // Stale clone from wrong URL — nuke and re-clone
            fs.rmSync(HUB_DIR, { recursive: true, force: true });
          }
        }
        if (fs.existsSync(existingGit)) {
          execFileSync('git', ['pull', '--ff-only'], { cwd: HUB_DIR, env: gitEnv, timeout: 30_000 });
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, action: 'pulled', dir: HUB_DIR }) }] };
        } else {
          if (fs.existsSync(HUB_DIR)) fs.rmSync(HUB_DIR, { recursive: true, force: true });
          execFileSync('git', ['clone', '--depth', '1', cloneUrl, HUB_DIR], { env: gitEnv, timeout: 60_000 });
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, action: 'cloned', dir: HUB_DIR }) }] };
        }
      } catch (err) {
        throw new Error(`fetch_hub failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    server.tool('list_hub_teams', 'List teams in the hub catalog. Call fetch_hub first.', {}, async () => {
      const teamsDir = path.join(HUB_DIR, 'teams');
      if (!fs.existsSync(teamsDir)) return { content: [{ type: 'text' as const, text: 'Hub not fetched. Call fetch_hub first.' }] };
      const teams: Array<{ id: string; name: string; description?: string }> = [];
      for (const entry of fs.readdirSync(teamsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const m = hubReadJson<{ id: string; name: string; description?: string }>(path.join(teamsDir, entry.name, 'team.json'));
        if (m) teams.push({ id: m.id, name: m.name, description: m.description });
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(teams, null, 2) }] };
    });

    server.tool('get_hub_team', 'Get hub team details: agents, required secrets.', { team_id: z.string() }, async ({ team_id }) => {
      if (!/^[a-z0-9_-]+$/.test(team_id)) return { content: [{ type: 'text' as const, text: 'Invalid team_id format.' }] };
      const teamDir = path.join(HUB_DIR, 'teams', team_id);
      if (!fs.existsSync(teamDir)) return { content: [{ type: 'text' as const, text: `Team "${team_id}" not found in hub.` }] };
      const manifest = hubReadJson<{ id: string; name: string; description?: string }>(path.join(teamDir, 'team.json'));
      if (!manifest) return { content: [{ type: 'text' as const, text: `team.json not found for "${team_id}".` }] };
      const agentsDir = path.join(teamDir, 'agents');
      const agents: Array<{ id: string; name: string }> = [];
      if (fs.existsSync(agentsDir)) {
        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const am = hubReadJson<{ id: string; name: string }>(path.join(agentsDir, entry.name, 'manifest.json'));
          if (am) agents.push({ id: am.id, name: am.name });
        }
      }
      const requiredSecrets = hubTeamRequiredSecrets(team_id);
      const stored = hubReadJson<Record<string, string>>(path.join(opts.dataDir, 'secrets.json')) ?? {};
      const secretStatus = requiredSecrets.map((k) => ({ key: k, is_set: Boolean(stored[k]) }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...manifest, agents, required_secrets: secretStatus }, null, 2) }] };
    });

    server.tool('install_team', 'Install a team from hub: copy to /data/teams and /data/agents, start new agents.', { team_id: z.string() }, async ({ team_id }) => {
      if (!/^[a-z0-9_-]+$/.test(team_id)) return { content: [{ type: 'text' as const, text: 'Invalid team_id format.' }] };
      const teamDir = path.join(HUB_DIR, 'teams', team_id);
      if (!fs.existsSync(teamDir)) return { content: [{ type: 'text' as const, text: `Team "${team_id}" not found. Call fetch_hub first.` }] };
      const destDir = path.join(opts.dataDir, 'teams', team_id);
      fs.mkdirSync(destDir, { recursive: true });
      execFileSync('cp', ['-r', `${teamDir}/.`, destDir], { timeout: 10_000 });

      // Auto-install agents referenced in team.json from hub/agents/
      const teamJson = hubReadJson<{ agents?: string[] }>(path.join(teamDir, 'team.json'));
      const installedAgents: string[] = [];
      const skippedAgents: string[] = [];
      if (Array.isArray(teamJson?.agents)) {
        for (const agentId of teamJson.agents) {
          const agentHubDir = path.join(HUB_DIR, 'agents', agentId);
          if (!fs.existsSync(path.join(agentHubDir, 'manifest.json'))) { skippedAgents.push(agentId); continue; }
          const agentDestDir = path.join(opts.dataDir, 'agents', agentId);
          fs.mkdirSync(agentDestDir, { recursive: true });
          execFileSync('cp', ['-r', `${agentHubDir}/.`, agentDestDir], { timeout: 10_000 });
          installedAgents.push(agentId);
        }
      }

      const cfg = cfgLoad(configPath);
      const installed = (cfg.installed as { features: string[]; teams: string[] } | undefined) ?? { features: [], teams: [] };
      installed.teams = [...new Set([...installed.teams, team_id])];
      cfg.installed = installed;
      if (!cfg.setupCompleted) { cfg.setupCompleted = true; (cfg.meta as Record<string, unknown> | undefined ?? (cfg.meta = {}))['setupCompletedAt'] = new Date().toISOString(); }
      cfgSave(configPath, cfg);

      // Start each newly installed agent without triggering a full reload
      const startedAgents: string[] = [];
      for (const agentId of installedAgents) {
        try { await callInternal('POST', `/internal/agents/${agentId}/start-installed`); startedAgents.push(agentId); } catch (err) { logger.warn({ agentId, err: String(err) }, 'start-installed failed (best effort)'); }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, team_id, installed_to: destDir, agents_installed: installedAgents, agents_skipped: skippedAgents, agents_started: startedAgents }) }] };
    });

    server.tool('install_agent', 'Install a standalone agent from hub into /data/agents and start it.', { agent_id: z.string() }, async ({ agent_id }) => {
      if (!/^[a-z0-9_-]+$/.test(agent_id)) return { content: [{ type: 'text' as const, text: 'Invalid agent_id format.' }] };
      const agentHubDir = path.join(HUB_DIR, 'agents', agent_id);
      if (!fs.existsSync(path.join(agentHubDir, 'manifest.json'))) return { content: [{ type: 'text' as const, text: `Agent "${agent_id}" not found in hub. Call fetch_hub first.` }] };
      const agentDestDir = path.join(opts.dataDir, 'agents', agent_id);
      fs.mkdirSync(agentDestDir, { recursive: true });
      execFileSync('cp', ['-r', `${agentHubDir}/.`, agentDestDir], { timeout: 10_000 });
      try { await callInternal('POST', `/internal/agents/${agent_id}/start-installed`); } catch (err) { logger.warn({ agent_id, err: String(err) }, 'start-installed failed (best effort)'); }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, agent_id, installed_to: agentDestDir }) }] };
    });

    server.tool('list_hub_agents', 'List standalone agents available in the hub catalog. Call fetch_hub first.', {}, async () => {
      const agentsDir = path.join(HUB_DIR, 'agents');
      if (!fs.existsSync(agentsDir)) return { content: [{ type: 'text' as const, text: 'Hub not fetched yet. Call fetch_hub first.' }] };
      const agents = fs.readdirSync(agentsDir).filter((d) => fs.existsSync(path.join(agentsDir, d, 'manifest.json'))).map((d) => {
        const m = hubReadJson<{ id?: string; name?: string; description?: string }>(path.join(agentsDir, d, 'manifest.json'));
        return { id: d, name: m?.name ?? d, description: m?.description ?? '' };
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(agents, null, 2) }] };
    });

    server.tool(
      'deploy_feature',
      'Deploy a locally committed feature into /data/features and hot-reload it — no container restart needed. Source is read from /host-source/features/{feature_name}/.',
      { feature_name: z.string() },
      async ({ feature_name }) => {
        if (!/^[a-z0-9_-]+$/.test(feature_name)) {
          return { content: [{ type: 'text' as const, text: 'Invalid feature_name format (use lowercase letters, numbers, hyphens).' }] };
        }
        const srcDir = `/host-source/features/${feature_name}`;
        const destDir = path.join(opts.featuresDir, feature_name);
        if (!fs.existsSync(srcDir)) {
          return { content: [{ type: 'text' as const, text: `Feature directory not found: ${srcDir}. Make sure it was committed to the repo.` }] };
        }
        fs.mkdirSync(destDir, { recursive: true });
        execFileSync('cp', ['-r', `${srcDir}/.`, destDir], { timeout: 10_000 });
        try {
          await fetch(`http://localhost:${opts.apiPort}/internal/reload`, { method: 'POST' });
        } catch (err) {
          logger.warn({ feature_name, err: String(err) }, 'deploy_feature: reload failed (best effort)');
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, feature_name, deployed_to: destDir, note: 'Hot-reloaded — dashboard will refresh automatically.' }) }] };
      },
    );
  }

  return server;
}

// ─── McpGateway ───────────────────────────────────────────────────────────────

export class McpGateway {
  private httpServer?: http.Server;
  /** Cache: serverId → full tool descriptor list (from running container). */
  private toolCache = new Map<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>();
  /** Routing table: toolName → serverId. Rebuilt when toolCache is updated. */
  private routingTable = new Map<string, string>();

  constructor(
    private readonly ticketRegistry: TicketRegistry,
    private readonly resolvePermissions: PermissionResolver,
    private readonly resolveMcpAccess?: McpAccessResolver,
    private readonly mcpManager?: McpManager,
    private readonly mcpServerRegistry?: McpServerRegistry,
    private readonly gatewayOpts?: GatewayOptions,
  ) {}

  start(port: number): void {
    const app = express();
    app.use(express.json());

    app.post('/mcp', async (req: Request, res: Response) => {
      const agentId = (req.headers['x-agent-id'] as string | undefined) ?? 'unknown';
      const permissions = this.resolvePermissions(agentId);
      const mcpAccess = this.resolveMcpAccess?.(agentId) ?? {};

      logger.debug({ agentId }, 'MCP Gateway: request');

      try {
        const body = req.body as {
          jsonrpc?: string;
          id?: unknown;
          method?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };

        // ── tools/list — aggregate built-in + external tools ─────────────────
        if (body.method === 'tools/list') {
          const externalToolList = await this.getExternalToolList(agentId, mcpAccess);
          // Get built-in tool list by running a minimal McpServer
          const builtinTools = this.getBuiltinToolList(agentId, permissions);
          res.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [...builtinTools, ...externalToolList] },
          });
          return;
        }

        // ── tools/call — route to external server or built-in ─────────────────
        if (body.method === 'tools/call' && body.params?.name) {
          const toolName = body.params.name;
          const externalServer = this.findExternalServerForTool(toolName, mcpAccess);

          if (externalServer) {
            // Permission already verified inside findExternalServerForTool
            // Proxy to external MCP server container
            try {
              const result = await callExternalTool(
                externalServer,
                toolName,
                body.params.arguments ?? {},
              );
              res.json({ jsonrpc: '2.0', id: body.id, result });
            } catch (err) {
              res.json({
                jsonrpc: '2.0', id: body.id,
                error: { code: -32000, message: String(err) },
              });
            }
            return;
          }
        }

        // ── Built-in tools (tickets, etc.) via McpServer SDK ──────────────────
        const server = buildMcpServer(this.ticketRegistry, agentId, permissions, this.gatewayOpts);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        res.on('close', () => {
          void transport.close();
          void server.close();
        });
      } catch (err) {
        logger.error({ err, agentId }, 'MCP Gateway: request failed');
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP Gateway internal error' });
        }
      }
    });

    app.get('/mcp', (_req: Request, res: Response) => {
      res.json({
        name: 'nano-agent-mcp-gateway',
        version: '1.0.0',
        namespaces: ['tickets'],
        federation: this.mcpManager?.getStates().map((s) => s.id) ?? [],
      });
    });

    this.httpServer = app.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'MCP Gateway started');
    });
  }

  /**
   * Invalidate tool cache for a specific MCP server (call after restart).
   * Routing table entries for that server are also removed.
   */
  invalidateCache(serverId: string): void {
    this.toolCache.delete(serverId);
    // Remove routing table entries for this server
    for (const [toolName, sid] of this.routingTable) {
      if (sid === serverId) this.routingTable.delete(toolName);
    }
  }

  stop(): void {
    this.httpServer?.close();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Returns the URL of the external MCP server that handles a tool, if the agent has access.
   * Uses the dynamic routing table built from tool discovery.
   * Returns undefined if the tool is built-in or agent doesn't have access.
   */
  private findExternalServerForTool(
    toolName: string,
    mcpAccess: Record<string, string[] | '*'>,
  ): string | undefined {
    if (!this.mcpManager || !this.mcpServerRegistry) return undefined;

    // Look up routing table (built from dynamic discovery)
    const serverId = this.routingTable.get(toolName);
    if (!serverId) return undefined;

    // Agent must have access to this server
    const access = mcpAccess[serverId];
    if (access === undefined) return undefined;

    // Check fine-grained permission
    if (!this.mcpServerRegistry.isToolAllowed(toolName, serverId, access)) return undefined;

    return this.mcpManager.getUrl(serverId);
  }

  /**
   * Fetches and caches tool lists from all external MCP servers the agent has access to.
   * Builds/updates the routing table from discovered tool names.
   * Filters tools shown to the agent by mcp_access permissions.
   */
  private async getExternalToolList(
    agentId: string,
    mcpAccess: Record<string, string[] | '*'>,
  ): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    if (!this.mcpManager || !this.mcpServerRegistry || Object.keys(mcpAccess).length === 0) {
      return [];
    }

    const result: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];

    for (const serverId of Object.keys(mcpAccess)) {
      const serverUrl = this.mcpManager.getUrl(serverId);
      if (!serverUrl) {
        logger.debug({ agentId, serverId }, 'MCP server not running — skipping tools');
        continue;
      }

      // Fetch tool list from container and cache
      let tools = this.toolCache.get(serverId);
      if (!tools) {
        tools = await fetchToolsFromServer(serverUrl);
        this.toolCache.set(serverId, tools);
        // Update routing table with newly discovered tools
        for (const tool of tools) {
          this.routingTable.set(tool.name, serverId);
        }
        logger.debug({ serverId, count: tools.length }, 'MCP server tools discovered and cached');
      }

      // Return only tools the agent is allowed to call
      const access = mcpAccess[serverId];
      for (const tool of tools) {
        if (this.mcpServerRegistry.isToolAllowed(tool.name, serverId, access)) {
          result.push(tool);
        }
      }
    }

    return result;
  }

  /**
   * Returns the built-in tool descriptors for a given agent (filtered by permissions).
   * Used for tools/list aggregation — does not create a live McpServer.
   */
  private getBuiltinToolList(
    _agentId: string,
    permissions: PermissionMap,
  ): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];

    if (canCallBuiltin(permissions, 'tickets', 'tickets_list')) {
      tools.push({ name: 'tickets_list', description: 'List tickets with optional filters.', inputSchema: { type: 'object', properties: { status: { type: 'string' }, priority: { type: 'string' }, assignee: { type: 'string' } } } });
    }
    if (canCallBuiltin(permissions, 'tickets', 'ticket_get')) {
      tools.push({ name: 'ticket_get', description: 'Get a single ticket with its comments.', inputSchema: { type: 'object', required: ['ticket_id'], properties: { ticket_id: { type: 'string' } } } });
    }
    if (canCallBuiltin(permissions, 'tickets', 'ticket_create')) {
      tools.push({ name: 'ticket_create', description: 'Create a new ticket.', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string' }, type: { type: 'string' } } } });
    }
    if (canCallBuiltin(permissions, 'tickets', 'ticket_update')) {
      tools.push({ name: 'ticket_update', description: 'Update ticket fields. Pass status to transition pipeline: "in_progress" triggers Developer, "review" triggers Reviewer, "done" closes.', inputSchema: { type: 'object', required: ['ticket_id'], properties: { ticket_id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string' }, assignee: { type: 'string' }, status: { type: 'string' } } } });
    }
    if (canCallBuiltin(permissions, 'tickets', 'ticket_approve')) {
      tools.push({ name: 'ticket_approve', description: 'Approve a ticket.', inputSchema: { type: 'object', required: ['ticket_id'], properties: { ticket_id: { type: 'string' }, assignee: { type: 'string' } } } });
    }
    if (canCallBuiltin(permissions, 'tickets', 'ticket_reject')) {
      tools.push({ name: 'ticket_reject', description: 'Reject a ticket.', inputSchema: { type: 'object', required: ['ticket_id'], properties: { ticket_id: { type: 'string' } } } });
    }
    if (canCallBuiltin(permissions, 'tickets', 'ticket_comment')) {
      tools.push({ name: 'ticket_comment', description: 'Add a comment to a ticket.', inputSchema: { type: 'object', required: ['ticket_id', 'body'], properties: { ticket_id: { type: 'string' }, body: { type: 'string' } } } });
    }

    if (this.gatewayOpts && permissions['config'] !== undefined) {
      if (canCallBuiltin(permissions, 'config', 'config_get'))
        tools.push({ name: 'config_get', description: 'Read current config or a specific value (secrets masked).', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } });
      if (canCallBuiltin(permissions, 'config', 'config_set'))
        tools.push({ name: 'config_set', description: 'Write a config value at a dot-path.', inputSchema: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: {} } } });
      if (canCallBuiltin(permissions, 'config', 'config_status'))
        tools.push({ name: 'config_status', description: 'Check what is missing for setup to complete.', inputSchema: { type: 'object', properties: {} } });
      if (canCallBuiltin(permissions, 'config', 'setup_complete'))
        tools.push({ name: 'setup_complete', description: 'Mark setup as done and trigger live reload.', inputSchema: { type: 'object', properties: { install: { type: 'array', items: { type: 'string' } } } } });
      if (canCallBuiltin(permissions, 'config', 'list_available'))
        tools.push({ name: 'list_available', description: 'List installable teams and features.', inputSchema: { type: 'object', properties: {} } });
      if (canCallBuiltin(permissions, 'config', 'list_secrets'))
        tools.push({ name: 'list_secrets', description: 'List all secret keys and whether they are set (values never exposed).', inputSchema: { type: 'object', properties: {} } });
      if (canCallBuiltin(permissions, 'config', 'set_secret'))
        tools.push({ name: 'set_secret', description: 'Store a secret value in data/secrets.json (mode 0600).', inputSchema: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } } });
      if (canCallBuiltin(permissions, 'config', 'check_secrets'))
        tools.push({ name: 'check_secrets', description: 'Check which required secrets are missing for given MCP server IDs.', inputSchema: { type: 'object', required: ['server_ids'], properties: { server_ids: { type: 'array', items: { type: 'string' } } } } });
    }

    if (this.gatewayOpts && permissions['management'] !== undefined) {
      tools.push({ name: 'get_system_status', description: 'Get current system status: running agents, MCP servers, setup mode.', inputSchema: { type: 'object', properties: {} } });
      tools.push({ name: 'start_agent', description: 'Start a stopped or dead agent by ID.', inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'string' } } } });
      tools.push({ name: 'stop_agent', description: 'Stop a running agent by ID.', inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'string' } } } });
      tools.push({ name: 'restart_mcp_server', description: 'Restart an MCP server container (use after updating its secrets).', inputSchema: { type: 'object', required: ['server_id'], properties: { server_id: { type: 'string' } } } });
      tools.push({ name: 'fetch_hub', description: 'Clone or update the hub catalog from git.', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } });
      tools.push({ name: 'list_hub_teams', description: 'List teams in the hub catalog. Call fetch_hub first.', inputSchema: { type: 'object', properties: {} } });
      tools.push({ name: 'get_hub_team', description: 'Get hub team details: agents, required secrets.', inputSchema: { type: 'object', required: ['team_id'], properties: { team_id: { type: 'string' } } } });
      tools.push({ name: 'install_team', description: 'Install a team from hub: copy to /data/teams, update config, trigger reload.', inputSchema: { type: 'object', required: ['team_id'], properties: { team_id: { type: 'string' } } } });
      tools.push({ name: 'list_hub_agents', description: 'List standalone agents available in the hub catalog.', inputSchema: { type: 'object', properties: {} } });
      tools.push({ name: 'install_agent', description: 'Install a standalone agent from hub into /data/agents and start it.', inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'string' } } } });
      tools.push({ name: 'deploy_feature', description: 'Deploy a locally committed feature into /data/features and hot-reload it. No container restart needed.', inputSchema: { type: 'object', required: ['feature_name'], properties: { feature_name: { type: 'string' } } } });
    }

    return tools;
  }
}
