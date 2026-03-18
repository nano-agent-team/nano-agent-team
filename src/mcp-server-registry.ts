/**
 * McpServerRegistry — catalog of available MCP servers
 *
 * Scans two locations:
 *   /app/mcp-servers/{id}/manifest.json  — built-in (shipped with nano-agent-team)
 *   /data/mcp-servers/{id}/manifest.json — installed (from hub or manually)
 *
 * Each MCP server manifest describes:
 *   - Docker image to run
 *   - Secrets required (injected as env vars by McpManager)
 *   - Actions with their corresponding tool names (for permission enforcement)
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { DATA_DIR } from './config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpServerManifest {
  /** Unique identifier, e.g. "github", "jira", "slack" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Docker image, e.g. "nano-mcp-github:1.0.0" */
  image: string;
  /** Port the MCP server listens on inside the container. Default: 3000 */
  port?: number;
  /**
   * Secret keys this server requires — must be present in SecretStore.
   * McpManager injects them as env vars when starting the container.
   * Example: ["GH_TOKEN", "GH_WEBHOOK_SECRET"]
   */
  required_secrets: string[];
  /**
   * Optional: maps logical action names to tool name patterns.
   * Used as permission templates in agent mcp_access declarations.
   * If omitted, tool routing is fully dynamic (discovered from the running container).
   *
   * Example:
   *   "pr.read":  ["github_list_prs", "github_get_pr"]
   *   "pr.write": ["github_create_pr", "github_merge_pr"]
   *
   * Agent can then declare: mcp_access: { "github": ["pr.read"] }
   * or use patterns:        mcp_access: { "github": ["github_list_*"] }
   * or allow everything:    mcp_access: { "github": "*" }
   */
  actions?: Record<string, string[]>;
}

// ─── Glob matching ────────────────────────────────────────────────────────────

/**
 * Simple glob matching: supports * (any sequence) and ? (single char).
 * Used for mcp_access tool name patterns like "github_list_*".
 */
function matchGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const BUILTIN_MCP_SERVERS_DIR = process.env.MCP_SERVERS_DIR ?? './mcp-servers';
const DATA_MCP_SERVERS_DIR = path.join(DATA_DIR, 'mcp-servers');

export class McpServerRegistry {
  private servers = new Map<string, McpServerManifest>();

  load(): void {
    this.servers.clear();
    this.scanDir(BUILTIN_MCP_SERVERS_DIR);
    this.scanDir(DATA_MCP_SERVERS_DIR);
    logger.info({ count: this.servers.size }, 'MCP server registry loaded');
  }

  private scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(
          fs.readFileSync(manifestPath, 'utf8'),
        ) as McpServerManifest;
        this.servers.set(manifest.id, manifest);
        logger.debug({ id: manifest.id, image: manifest.image }, 'MCP server registered');
      } catch (err) {
        logger.warn({ err, manifestPath }, 'Failed to load MCP server manifest');
      }
    }
  }

  get(id: string): McpServerManifest | undefined {
    return this.servers.get(id);
  }

  getAll(): McpServerManifest[] {
    return [...this.servers.values()];
  }

  /**
   * Check if an agent is allowed to call a specific tool, given its mcp_access for a server.
   *
   * Access rules (in priority order):
   *   "*"                  → allow all tools
   *   "github_list_*"      → glob pattern match against tool name
   *   "pr.read"            → logical action name resolved via manifest.actions
   *
   * Called by the gateway with the runtime tool list from the running container.
   */
  isToolAllowed(
    toolName: string,
    serverId: string,
    access: string[] | '*',
  ): boolean {
    // Wildcard — allow everything
    if (access === '*') return true;

    const server = this.servers.get(serverId);

    for (const rule of access) {
      // Glob pattern: contains * or ?
      if (rule.includes('*') || rule.includes('?')) {
        if (matchGlob(rule, toolName)) return true;
        continue;
      }

      // Logical action name (via manifest.actions)
      if (server?.actions) {
        const actionTools = server.actions[rule] ?? [];
        if (actionTools.includes(toolName)) return true;
      }

      // Exact tool name match
      if (rule === toolName) return true;
    }

    return false;
  }

  /**
   * Build a routing table: toolName → serverId.
   * Built dynamically from the tool lists discovered from running containers.
   * Called by McpGateway after fetching tool lists.
   */
  buildRoutingTable(
    toolListsByServer: Map<string, string[]>,
  ): Map<string, string> {
    const table = new Map<string, string>();
    for (const [serverId, toolNames] of toolListsByServer) {
      for (const toolName of toolNames) {
        table.set(toolName, serverId);
      }
    }
    return table;
  }
}
