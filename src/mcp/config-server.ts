/**
 * Config MCP Server
 *
 * Provides tools for the settings agent to read/write /data/config.json.
 * Runs as a child process inside the settings agent container.
 *
 * Tools:
 *   config_get       — read config (secrets masked)
 *   config_set       — write a value at dot-path
 *   config_status    — what's missing for setup to complete
 *   setup_complete   — mark setup done + trigger live reload
 *   list_available   — list installable teams + features
 */

import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const API_PORT = process.env.API_PORT ?? '3001';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const FEATURES_DIR = process.env.FEATURES_DIR ?? '/app/features';
const TEAMS_DIR = process.env.TEAMS_DIR ?? '/app/teams';

// ── Config helpers ────────────────────────────────────────────────────────────

function loadConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, unknown>): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const masked = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const provider = masked.provider as Record<string, unknown> | undefined;
  if (provider?.apiKey) provider.apiKey = '***';
  return masked;
}

function getNestedValue(obj: Record<string, unknown>, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setNestedValue(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

function getMissing(config: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const provider = config.provider as Record<string, unknown> | undefined;
  if (!provider?.apiKey) missing.push('provider.apiKey');
  if (!provider?.type) missing.push('provider.type');
  return missing;
}

function scanManifests(dir: string, filename: string): Array<{ id: string; name: string }> {
  if (!fs.existsSync(dir)) return [];
  const result: Array<{ id: string; name: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mPath = path.join(dir, entry.name, filename);
    if (fs.existsSync(mPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(mPath, 'utf8')) as { id: string; name: string };
        if (m.id !== 'settings') result.push({ id: m.id, name: m.name });
      } catch { /* skip */ }
    }
  }
  return result;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'config-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'config_get',
      description: 'Read current config or a specific section. Secrets are masked.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Dot-path like "provider.type". Omit to get full config.',
          },
        },
      },
    },
    {
      name: 'config_set',
      description: 'Write a config value at a dot-path. Example: config_set("provider.apiKey", "sk-ant-...")',
      inputSchema: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key: { type: 'string', description: 'Dot-path like "provider.apiKey"' },
          value: { description: 'Value to set (any JSON type)' },
        },
      },
    },
    {
      name: 'config_status',
      description: 'Check what is missing for setup to be complete.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'setup_complete',
      description: 'Mark setup as done and trigger live reload of installed features/teams.',
      inputSchema: {
        type: 'object',
        properties: {
          install: {
            type: 'array',
            items: { type: 'string' },
            description: 'Team or feature IDs to install, e.g. ["dev-team"]',
          },
        },
      },
    },
    {
      name: 'list_available',
      description: 'List teams and features available to install.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

  switch (name) {
    case 'config_get': {
      const config = loadConfig();
      const key = a.key as string | undefined;
      const value = key ? getNestedValue(config, key.split('.')) : maskSecrets(config);
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
    }

    case 'config_set': {
      const key = a.key as string;
      const value = a.value;
      const config = loadConfig();
      setNestedValue(config, key.split('.'), value);
      saveConfig(config);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, key }) }] };
    }

    case 'config_status': {
      const config = loadConfig();
      const missing = getMissing(config);
      const setupCompleted = config.setupCompleted === true;
      const complete = setupCompleted && missing.length === 0;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ complete, setupCompleted, missing }),
        }],
      };
    }

    case 'setup_complete': {
      const install = (a.install as string[] | undefined) ?? [];
      const config = loadConfig();

      // Categorize install items
      const teams: string[] = [];
      const features: string[] = [];
      for (const id of install) {
        const teamManifest = path.join(TEAMS_DIR, id, 'team.json');
        if (fs.existsSync(teamManifest)) teams.push(id);
        else features.push(id);
      }

      config.setupCompleted = true;
      const installed = config.installed as { features: string[]; teams: string[] } | undefined
        ?? { features: [], teams: [] };
      installed.features = [...new Set([...installed.features, ...features])];
      installed.teams = [...new Set([...installed.teams, ...teams])];
      config.installed = installed;

      const meta = config.meta as Record<string, unknown> | undefined ?? {};
      meta.setupCompletedAt = new Date().toISOString();
      config.meta = meta;

      saveConfig(config);

      // Trigger live reload via internal API
      try {
        await fetch(`http://localhost:${API_PORT}/internal/reload`, { method: 'POST' });
      } catch { /* best effort */ }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, installed }),
        }],
      };
    }

    case 'list_available': {
      const teams = scanManifests(TEAMS_DIR, 'team.json');
      const features = scanManifests(FEATURES_DIR, 'feature.json');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ teams, features }),
        }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
