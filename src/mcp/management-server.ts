/**
 * Management MCP Server — system control + hub catalog browsing + agent authoring
 *
 * Runs as a child process inside the settings agent container (stdio transport).
 * Communicates with the control plane via internal HTTP API.
 *
 * Tools:
 *   get_system_status      — running agents + MCP servers + setup mode
 *   start_agent            — start a stopped/dead agent
 *   stop_agent             — stop a running agent
 *   restart_mcp_server     — restart an MCP server (picks up updated secrets)
 *   fetch_hub              — git clone/pull hub catalog to /tmp/hub
 *   list_hub_teams         — list teams available in hub
 *   get_hub_team           — team details: agents, required secrets, description
 *   install_team           — install team from hub + trigger reload
 *   install_agent          — install standalone agent from hub + trigger reload
 *   get_agent_definition   — read manifest, CLAUDE.md, Dockerfile for an agent in /data/agents/
 *   save_agent_definition  — write/update manifest, CLAUDE.md, Dockerfile for an agent
 *   build_agent_image      — build Docker image from agent's Dockerfile
 *   list_routes            — list persistent topic→agent routes from /data/routes.json
 *   create_route           — add a persistent route: topic → agent entrypoint
 *   delete_route           — remove a persistent route by from_topic
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/** Internal API base URL — control plane accessible from inside agent container */
const CONTROL_PLANE_URL =
  process.env.CONTROL_PLANE_URL ?? 'http://host.docker.internal:3001';

/** Default hub git URL — can be overridden per call or via config */
const DEFAULT_HUB_URL =
  process.env.HUB_URL ?? 'https://github.com/nano-agent-team-dev/hub.git';

const HUB_DIR = '/tmp/hub';

// ── Config helpers ─────────────────────────────────────────────────────────────

function loadConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Control plane API helpers ──────────────────────────────────────────────────

async function callInternal(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${CONTROL_PLANE_URL}${endpoint}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${endpoint} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Hub helpers ────────────────────────────────────────────────────────────────

function hubTeamPath(teamId: string): string {
  return path.join(HUB_DIR, 'teams', teamId);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface TeamManifest {
  id: string;
  name: string;
  description?: string;
  agents?: string[];
}

interface AgentManifest {
  id: string;
  name: string;
  description?: string;
  mcp_access?: Record<string, string[] | '*'>;
  required_secrets?: string[];
}

interface McpServerManifest {
  id: string;
  required_secrets?: string[];
}

function getTeamRequiredSecrets(teamId: string): string[] {
  const teamDir = hubTeamPath(teamId);
  const secrets = new Set<string>();

  // From agent mcp_access → look up MCP server manifests
  const agentsDir = path.join(teamDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readJson<AgentManifest>(
        path.join(agentsDir, entry.name, 'manifest.json'),
      );
      if (!manifest) continue;

      // Explicit required_secrets on agent
      manifest.required_secrets?.forEach((s) => secrets.add(s));

      // MCP server required_secrets via mcp_access
      if (manifest.mcp_access) {
        for (const serverId of Object.keys(manifest.mcp_access)) {
          const mcpManifest = readJson<McpServerManifest>(
            path.join(HUB_DIR, 'mcp-servers', serverId, 'manifest.json'),
          );
          mcpManifest?.required_secrets?.forEach((s) => secrets.add(s));
        }
      }
    }
  }

  return [...secrets];
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'management-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'get_system_status',
      description: 'Get current system status: running agents, MCP servers, setup mode.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'start_agent',
      description: 'Start a stopped or dead agent by ID.',
      inputSchema: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'Agent ID, e.g. "pm" or "developer"' },
        },
      },
    },
    {
      name: 'stop_agent',
      description: 'Stop a running agent by ID.',
      inputSchema: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'Agent ID' },
        },
      },
    },
    {
      name: 'restart_mcp_server',
      description: 'Restart an MCP server container (use after updating its secrets).',
      inputSchema: {
        type: 'object',
        required: ['server_id'],
        properties: {
          server_id: { type: 'string', description: 'MCP server ID, e.g. "github"' },
        },
      },
    },
    {
      name: 'fetch_hub',
      description: 'Clone or update the hub catalog from git. Required before list_hub_teams.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: `Git URL to clone. Defaults to ${DEFAULT_HUB_URL}`,
          },
        },
      },
    },
    {
      name: 'list_hub_teams',
      description: 'List all teams available in the hub catalog. Call fetch_hub first.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_hub_team',
      description: 'Get details of a hub team: description, agents, and required secrets.',
      inputSchema: {
        type: 'object',
        required: ['team_id'],
        properties: {
          team_id: { type: 'string', description: 'Team ID, e.g. "github-team"' },
        },
      },
    },
    {
      name: 'install_team',
      description: 'Install a team from hub: copies files to /data/teams, updates config, triggers reload.',
      inputSchema: {
        type: 'object',
        required: ['team_id'],
        properties: {
          team_id: { type: 'string', description: 'Team ID to install' },
        },
      },
    },
    {
      name: 'install_agent',
      description: 'Install a standalone agent from hub catalog into /data/agents/, triggers reload.',
      inputSchema: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'Agent ID from hub/agents/, e.g. "agent-creator"' },
        },
      },
    },
    {
      name: 'get_agent_definition',
      description: 'Read the definition files (manifest.json, CLAUDE.md, Dockerfile) of an agent in /data/agents/.',
      inputSchema: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'Agent ID' },
        },
      },
    },
    {
      name: 'save_agent_definition',
      description: 'Create or update an agent definition in /data/agents/{id}/. Pass only the fields you want to write/overwrite. Set dockerfile to null to remove it.',
      inputSchema: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'Agent ID (kebab-case, e.g. "my-agent")' },
          manifest: {
            type: 'object',
            description: 'Agent manifest (id, name, model, session_type, entrypoints, …)',
          },
          claude_md: { type: 'string', description: 'CLAUDE.md system prompt content' },
          dockerfile: {
            description: 'Dockerfile content as string, or null to remove it',
          },
        },
      },
    },
    {
      name: 'build_agent_image',
      description: 'Build a Docker image from /data/agents/{id}/Dockerfile. Tags as nano-agent-{id}:latest.',
      inputSchema: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'Agent ID' },
        },
      },
    },
    {
      name: 'list_routes',
      description: 'List all persistent topic→agent routes defined in /data/routes.json.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'create_route',
      description: 'Create a persistent route: messages published to from_topic are forwarded to the agent\'s entrypoint. Stored in /data/routes.json, activated immediately.',
      inputSchema: {
        type: 'object',
        required: ['from_topic', 'to_agent_id'],
        properties: {
          from_topic: { type: 'string', description: 'NATS topic to listen on, e.g. "topic.github.pr.finding"' },
          to_agent_id: { type: 'string', description: 'Target agent ID, e.g. "product-owner"' },
          to_entrypoint: { type: 'string', description: 'Target entrypoint: "inbox" (default) or "event"' },
        },
      },
    },
    {
      name: 'delete_route',
      description: 'Remove a persistent route by its from_topic.',
      inputSchema: {
        type: 'object',
        required: ['from_topic'],
        properties: {
          from_topic: { type: 'string', description: 'The from_topic of the route to remove' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

  switch (name) {
    // ── System status ──────────────────────────────────────────────────────────
    case 'get_system_status': {
      const status = await callInternal('GET', '/internal/status');
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    // ── Agent lifecycle ────────────────────────────────────────────────────────
    case 'start_agent': {
      const result = await callInternal('POST', `/internal/agents/${a.agent_id as string}/start`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'stop_agent': {
      const result = await callInternal('POST', `/internal/agents/${a.agent_id as string}/stop`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'restart_mcp_server': {
      const result = await callInternal('POST', `/internal/mcp-servers/${a.server_id as string}/restart`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    // ── Hub catalog ────────────────────────────────────────────────────────────
    case 'fetch_hub': {
      const url = (a.url as string | undefined) ?? DEFAULT_HUB_URL;
      const ghToken = process.env.GH_TOKEN;

      // Build authenticated URL if GH_TOKEN is available (for private hub)
      let cloneUrl = url;
      if (ghToken && url.includes('github.com')) {
        cloneUrl = url.replace('https://', `https://oauth2:${ghToken}@`);
      }

      try {
        if (fs.existsSync(path.join(HUB_DIR, '.git'))) {
          // Already cloned — pull latest
          execFileSync('git', ['pull', '--ff-only'], {
            cwd: HUB_DIR,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', GIT_TERMINAL_PROMPT: '0' },
            timeout: 30_000,
          });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'pulled', dir: HUB_DIR }) }] };
        } else {
          // Fresh clone
          if (fs.existsSync(HUB_DIR)) fs.rmSync(HUB_DIR, { recursive: true, force: true });
          execFileSync('git', ['clone', '--depth', '1', cloneUrl, HUB_DIR], {
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', GIT_TERMINAL_PROMPT: '0' },
            timeout: 60_000,
          });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'cloned', dir: HUB_DIR }) }] };
        }
      } catch (err) {
        throw new Error(`fetch_hub failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    case 'list_hub_teams': {
      const teamsDir = path.join(HUB_DIR, 'teams');
      if (!fs.existsSync(teamsDir)) {
        return { content: [{ type: 'text', text: 'Hub not fetched. Call fetch_hub first.' }], isError: true };
      }

      const teams: Array<{ id: string; name: string; description?: string }> = [];
      for (const entry of fs.readdirSync(teamsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = readJson<TeamManifest>(
          path.join(teamsDir, entry.name, 'team.json'),
        );
        if (manifest) {
          teams.push({ id: manifest.id, name: manifest.name, description: manifest.description });
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(teams, null, 2) }] };
    }

    case 'get_hub_team': {
      const teamId = a.team_id as string;
      if (!/^[a-z0-9_-]+$/.test(teamId)) {
        return { content: [{ type: 'text', text: 'Invalid team_id format.' }], isError: true };
      }
      const teamDir = hubTeamPath(teamId);

      if (!fs.existsSync(teamDir)) {
        return { content: [{ type: 'text', text: `Team "${teamId}" not found in hub.` }], isError: true };
      }

      const manifest = readJson<TeamManifest>(path.join(teamDir, 'team.json'));
      if (!manifest) {
        return { content: [{ type: 'text', text: `team.json not found for "${teamId}".` }], isError: true };
      }

      // List agents
      const agentsDir = path.join(teamDir, 'agents');
      const agents: Array<{ id: string; name: string; description?: string }> = [];
      if (fs.existsSync(agentsDir)) {
        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const agentManifest = readJson<AgentManifest>(
            path.join(agentsDir, entry.name, 'manifest.json'),
          );
          if (agentManifest) {
            agents.push({ id: agentManifest.id, name: agentManifest.name, description: agentManifest.description });
          }
        }
      }

      // Collect required secrets from agents' mcp_access
      const requiredSecrets = getTeamRequiredSecrets(teamId);

      // Check which secrets are already set
      const secretsPath = path.join(DATA_DIR, 'secrets.json');
      const storedSecrets = readJson<Record<string, string>>(secretsPath) ?? {};
      const secretStatus = requiredSecrets.map((key) => ({
        key,
        is_set: Boolean(storedSecrets[key]),
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...manifest, agents, required_secrets: secretStatus }, null, 2),
        }],
      };
    }

    case 'install_team': {
      const teamId = a.team_id as string;
      if (!/^[a-z0-9_-]+$/.test(teamId)) {
        return { content: [{ type: 'text', text: 'Invalid team_id format.' }], isError: true };
      }
      const teamDir = hubTeamPath(teamId);

      if (!fs.existsSync(teamDir)) {
        return {
          content: [{ type: 'text', text: `Team "${teamId}" not found. Call fetch_hub first.` }],
          isError: true,
        };
      }

      // Copy team descriptor files (team.json, workflow.json, setup.json, src/, config/, shared/, …)
      // to /data/teams/{teamId}/ — but NOT the agents/ subdir (agents go to /data/agents/).
      const teamDestDir = path.join(DATA_DIR, 'teams', teamId);
      fs.mkdirSync(teamDestDir, { recursive: true });
      for (const entry of fs.readdirSync(teamDir, { withFileTypes: true })) {
        if (entry.name === 'agents') continue; // agents go to /data/agents/ instead
        const src = path.join(teamDir, entry.name);
        const dest = path.join(teamDestDir, entry.name);
        execFileSync('cp', ['-r', src, dest], { timeout: 10_000 });
      }

      // Copy each agent to /data/agents/{agentId}/
      const hubAgentsDir = path.join(teamDir, 'agents');
      const installedAgents: string[] = [];
      if (fs.existsSync(hubAgentsDir)) {
        for (const entry of fs.readdirSync(hubAgentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const agentDest = path.join(DATA_DIR, 'agents', entry.name);
          fs.mkdirSync(agentDest, { recursive: true });
          execFileSync('cp', ['-r', `${path.join(hubAgentsDir, entry.name)}/.`, agentDest], { timeout: 10_000 });
          installedAgents.push(entry.name);
        }
      }

      // Update config.json
      const config = loadConfig();
      const installed = (config.installed as { features: string[]; teams: string[] } | undefined)
        ?? { features: [], teams: [] };
      installed.teams = [...new Set([...installed.teams, teamId])];
      config.installed = installed;
      if (!config.setupCompleted) {
        config.setupCompleted = true;
        const meta = (config.meta as Record<string, unknown> | undefined) ?? {};
        meta.setupCompletedAt = new Date().toISOString();
        config.meta = meta;
      }
      saveConfig(config);

      // Trigger live reload
      await callInternal('POST', '/internal/reload');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, team_id: teamId, team_dir: teamDestDir, agents: installedAgents }),
        }],
      };
    }

    case 'install_agent': {
      const agentId = a.agent_id as string;
      if (!/^[a-z0-9_-]+$/.test(agentId)) {
        return { content: [{ type: 'text', text: 'Invalid agent_id format.' }], isError: true };
      }
      const srcDir = path.join(HUB_DIR, 'agents', agentId);
      if (!fs.existsSync(srcDir)) {
        return {
          content: [{ type: 'text', text: `Agent "${agentId}" not found in hub. Call fetch_hub first.` }],
          isError: true,
        };
      }
      const destDir = path.join(DATA_DIR, 'agents', agentId);
      fs.mkdirSync(destDir, { recursive: true });
      execFileSync('cp', ['-r', `${srcDir}/.`, destDir], { timeout: 10_000 });
      await callInternal('POST', '/internal/reload');
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, agent_id: agentId, installed_to: destDir }) }],
      };
    }

    case 'get_agent_definition': {
      const agentId = a.agent_id as string;
      if (!/^[a-z0-9_-]+$/.test(agentId)) {
        return { content: [{ type: 'text', text: 'Invalid agent_id format.' }], isError: true };
      }
      const result = await callInternal('GET', `/internal/agents/${agentId}/definition`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'save_agent_definition': {
      const agentId = a.agent_id as string;
      if (!/^[a-z0-9_-]+$/.test(agentId)) {
        return { content: [{ type: 'text', text: 'Invalid agent_id format.' }], isError: true };
      }
      const body: Record<string, unknown> = {};
      if (a.manifest !== undefined) body.manifest = a.manifest;
      if (a.claude_md !== undefined) body.claude_md = a.claude_md;
      if (a.dockerfile !== undefined) body.dockerfile = a.dockerfile;
      const result = await callInternal('PUT', `/internal/agents/${agentId}/definition`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }


    case 'build_agent_image': {
      const agentId = a.agent_id as string;
      if (!/^[a-z0-9_-]+$/.test(agentId)) {
        return { content: [{ type: 'text', text: 'Invalid agent_id format.' }], isError: true };
      }
      const result = await callInternal('POST', `/internal/agents/${agentId}/build`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'list_routes': {
      const result = await callInternal('GET', '/internal/routes');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'create_route': {
      const fromTopic = a.from_topic as string;
      const toAgentId = a.to_agent_id as string;
      const toEntrypoint = (a.to_entrypoint as string | undefined) ?? 'inbox';
      if (!/^[a-z0-9._-]+$/.test(fromTopic)) {
        return { content: [{ type: 'text', text: 'Invalid from_topic format.' }], isError: true };
      }
      if (!/^[a-z0-9_-]+$/.test(toAgentId)) {
        return { content: [{ type: 'text', text: 'Invalid to_agent_id format.' }], isError: true };
      }
      const result = await callInternal('POST', '/internal/routes', { from_topic: fromTopic, to_agent_id: toAgentId, to_entrypoint: toEntrypoint });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'delete_route': {
      const fromTopic = a.from_topic as string;
      if (!/^[a-z0-9._-]+$/.test(fromTopic)) {
        return { content: [{ type: 'text', text: 'Invalid from_topic format.' }], isError: true };
      }
      const result = await callInternal('DELETE', `/internal/routes/${encodeURIComponent(fromTopic)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
