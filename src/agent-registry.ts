/**
 * Agent Registry
 *
 * Loads agent manifests from the agents/ directory.
 * Each agent is a subdirectory with a manifest.json file.
 *
 * No database — pure filesystem-based discovery.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

// ─── Port definition ──────────────────────────────────────────────────────────

export interface PortDefinition {
  port: string;
  description?: string;
}

// ─── Agent Manifest ───────────────────────────────────────────────────────────

export interface AgentManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  model?: string;
  /** Runtime type: deterministic (pure function) or non-deterministic (LLM) */
  kind?: 'deterministic' | 'non-deterministic';
  /** Agent role in the data flow */
  role?: 'source' | 'sink' | 'processor';
  /** Logical input ports (used with WorkflowBinding to resolve NATS subjects) */
  inputs?: PortDefinition[];
  /** Logical output ports (documentation only) */
  outputs?: PortDefinition[];
  /** NATS subjects the agent subscribes to (optional if inputs + workflow binding used) */
  subscribe_topics?: string[];
  /** NATS subjects the agent publishes to (documentation only) */
  publish_topics?: string[];
  /** Session management mode: stateless = new session per message, persistent = remembered history */
  session_type?: 'stateless' | 'persistent';
  /** Mount an isolated personal workspace at /workspace/personal (DATA_DIR/workspaces/{id}) */
  workspace?: boolean;
  /** Absolute host path to mount as /workspace/repo (for git-based workflows) */
  repo_path?: string;
  /** Docker image to use for this agent. Defaults to AGENT_IMAGE (nano-agent:latest) */
  image?: string;
  /**
   * Named entrypoint port names for this agent.
   * Each name resolves to subject: agent.{instanceId}.{portName}
   * "inbox" is always implicitly available (agent.{instanceId}.inbox).
   * Example: ["inbox", "tickets"] → agent receives on .inbox and .tickets
   */
  entrypoints?: string[];
  /** Mount host SSH keys (~/.ssh) into container for git SSH access */
  ssh_mount?: boolean;
  /** Capability tags for auto model selection: 'fast', 'cheap', 'reasoning', 'long-context', ... */
  capabilities?: string[];
  /** LLM provider: provider name or 'auto' (default: 'auto' = use primaryProvider) */
  provider?: string;
  /**
   * MCP Gateway permissions — which built-in tool operations this agent may call.
   * Key: MCP namespace (e.g. "tickets"). Value: array of allowed operations or "*" for all.
   * If omitted, all built-in tools are available (backward compat).
   * Example: { "tickets": ["get", "list", "comment", "approve"] }
   */
  mcp_permissions?: Record<string, string[] | '*'>;
  /**
   * MCP Federation access — which external MCP servers and actions this agent may use.
   * Key: MCP server ID (e.g. "github"). Value: array of action names or "*" for all.
   * Actions map to tool names via McpServerRegistry.
   * Example: { "github": ["pr.read", "pr.comment"] }
   *          { "github": "*" }
   */
  mcp_access?: Record<string, string[] | '*'>;
  /** Path to MCP config JSON file (e.g. /app/mcp/config-mcp.json) with mcpServers definitions */
  mcp_config?: string;
}

// ─── Workflow Binding ─────────────────────────────────────────────────────────

/**
 * Entrypoint route binding: external topic → named agent entrypoint.
 *
 * `from`  — external NATS subject the dispatcher listens on
 * `to`    — entrypoint port name declared in agent manifest.entrypoints
 *           Resolved to subject: agent.{instanceId}.{to}
 */
export interface WorkflowInputBinding {
  from: string;
  to: string;
}

/** A binding input value is either a plain subject (backward compat) or an entrypoint route */
export type InputBinding = string | WorkflowInputBinding;

/** Maps an agent's logical ports to concrete NATS subjects in a workflow */
export interface WorkflowBinding {
  /** port → subject (string) or port → { from, to } entrypoint route */
  inputs?: Record<string, InputBinding>;
  /** port → NATS subject for outputs */
  outputs?: Record<string, string>;
}

// ─── Workflow Manifest ────────────────────────────────────────────────────────

// ─── Multi-instance types ─────────────────────────────────────────────────────

/** Declaration of a single agent instance (or competing pool) in a workflow */
export interface WorkflowInstance {
  /** manifest.id (agent type) — which agent definition to use */
  manifest: string;
  /** Competing pool size: N containers share a single JetStream consumer (default 1) */
  count?: number;
  /** Vault config id override (defaults to instanceId) */
  vault?: string;
}

/** Dispatch routing rule for a NATS subject */
export interface DispatchConfig {
  strategy: 'competing' | 'broadcast' | 'least-busy' | 'round-robin';
  /** instanceIds participating in this dispatch group */
  to: string[];
}

// ─── Workflow Manifest ────────────────────────────────────────────────────────

export interface WorkflowManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Agent IDs participating in this workflow (legacy — use instances instead) */
  agents: string[];
  /** Tool IDs required by this workflow */
  tools?: string[];
  /** Instance declarations: instanceId → WorkflowInstance config */
  instances?: Record<string, WorkflowInstance>;
  /** Dispatch rules: NATS subject → DispatchConfig */
  dispatch?: Record<string, DispatchConfig>;
  /** Per-agent topic bindings: instanceId → WorkflowBinding */
  bindings?: Record<string, WorkflowBinding>;
  /** Legacy compat: pipeline.topics from team.json */
  pipeline?: { topics?: Record<string, string> };
}

// ─── Loaded Agent ─────────────────────────────────────────────────────────────

export interface LoadedAgent {
  manifest: AgentManifest;
  /** Absolute path to the agent directory */
  dir: string;
  /** Team ID when agent is loaded in team context (enables per-team container naming) */
  teamId?: string;
  /** Workflow topic bindings resolved at load time (optional) */
  binding?: WorkflowBinding;
  /** Instance ID — unique per running container (defaults to manifest.id) */
  instanceId?: string;
  /** JetStream consumer name override (competing pools share manifest.id consumer) */
  consumerName?: string;
  /** Vault config id for per-instance overrides (defaults to instanceId) */
  vaultId?: string;
}

/**
 * Get the effective instance ID for an agent.
 * Falls back to manifest.id when no explicit instanceId is set.
 */
export function getInstanceId(agent: LoadedAgent): string {
  return agent.instanceId ?? agent.manifest.id;
}

// ─── Topic resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the NATS subjects an agent should subscribe to.
 *
 * Resolution priority:
 * 1. Workflow binding inputs (if provided) — port → subject mapping
 * 2. manifest.subscribe_topics
 * 3. Fallback: agent.{id}.inbox only (with warning)
 */
export function resolveTopicsForAgent(
  agent: AgentManifest,
  binding?: WorkflowBinding,
  instanceId?: string,
): string[] {
  const id = instanceId ?? agent.id;
  const inbox = `agent.${id}.inbox`;

  if (binding?.inputs) {
    const subjects = new Set<string>([inbox]);
    for (const input of Object.values(binding.inputs)) {
      if (typeof input === 'string') {
        // Backward compat: plain subject added directly to consumer filter
        subjects.add(input);
      } else {
        // Entrypoint route: consumer filters on the TO subject (agent.{id}.{portName})
        // The FROM subject is handled by WorkflowDispatcher — agent never subscribes to it
        subjects.add(`agent.${id}.${input.to}`);
      }
    }
    return [...subjects];
  }

  if (agent.subscribe_topics && agent.subscribe_topics.length > 0) {
    return agent.subscribe_topics;
  }

  // Fallback: inbox only
  logger.warn({ agentId: agent.id }, 'No subscribe_topics or workflow binding — using inbox only');
  return [inbox];
}

// ─── Manifest loader ──────────────────────────────────────────────────────────

/**
 * Load and validate a manifest.json from the given agent directory.
 * Throws if the manifest is missing or invalid.
 */
export function loadManifest(agentDir: string): AgentManifest {
  const manifestPath = path.join(agentDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in: ${agentDir}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot parse manifest.json in ${agentDir}: ${String(err)}`);
  }

  const m = raw as Partial<AgentManifest>;

  if (!m.id || typeof m.id !== 'string') {
    throw new Error(`manifest.json in ${agentDir}: missing or invalid "id"`);
  }
  if (!m.name || typeof m.name !== 'string') {
    throw new Error(`manifest.json in ${agentDir}: missing or invalid "name"`);
  }
  if (!m.version || typeof m.version !== 'string') {
    throw new Error(`manifest.json in ${agentDir}: missing or invalid "version"`);
  }

  // subscribe_topics is now optional — warn if both subscribe_topics and inputs are absent
  const hasSubscribeTopics = Array.isArray(m.subscribe_topics) && m.subscribe_topics.length > 0;
  const hasInputPorts = Array.isArray(m.inputs) && m.inputs.length > 0;
  if (!hasSubscribeTopics && !hasInputPorts) {
    logger.warn(
      { agentId: m.id, agentDir },
      'manifest.json: neither "subscribe_topics" nor "inputs" defined — agent will use inbox only',
    );
  }

  return m as AgentManifest;
}

/**
 * Scan the given agents directory and load all valid agent manifests.
 * If a subdirectory has no manifest.json but contains subdirectories,
 * treat it as a plugin group and scan one level deeper (e.g. agents/dev-team/).
 * Skips subdirectories that are missing or have invalid manifests (with a warning).
 */
export function loadAgents(agentsDir: string): LoadedAgent[] {
  const resolvedDir = path.resolve(agentsDir);

  if (!fs.existsSync(resolvedDir)) {
    logger.warn({ agentsDir: resolvedDir }, 'Agents directory does not exist');
    return [];
  }

  const agents: LoadedAgent[] = [];
  scanDirectory(resolvedDir, agents);

  logger.info({ count: agents.length, agentsDir: resolvedDir }, 'Agents loaded');
  return agents;
}

/**
 * Load team agents using team.json as the source of truth, with root agent fallback.
 *
 * For each agentId listed in team.json:
 *   1. Check `teamDir/agents/{agentId}/manifest.json` — use if present (team override)
 *   2. Fall back to `rootAgentsDir/{agentId}/manifest.json` — shared root definition
 *
 * Agents loaded this way carry teamId so AgentManager can name containers
 * `nano-agent-{teamId}-{agentId}`, preventing conflicts when multiple teams
 * share the same root agent definition.
 *
 * Falls back to scanning teamDir/agents/ if team.json is missing or has no agents[].
 */
export function loadTeamAgentsWithFallback(
  teamId: string,
  teamDir: string,
  rootAgentsDir: string,
): LoadedAgent[] {
  const teamJsonPath = path.join(teamDir, 'team.json');

  // No team.json — scan team agents dir the old way
  if (!fs.existsSync(teamJsonPath)) {
    return loadAgents(path.join(teamDir, 'agents')).map((a) => ({ ...a, teamId }));
  }

  let team: { agents?: string[] };
  try {
    team = JSON.parse(fs.readFileSync(teamJsonPath, 'utf8')) as { agents?: string[] };
  } catch (err) {
    logger.warn({ err, teamId, teamJsonPath }, 'Cannot parse team.json — skipping team agents');
    return [];
  }

  if (!Array.isArray(team.agents) || team.agents.length === 0) {
    logger.debug({ teamId }, 'team.json has no agents[] — nothing to load');
    return [];
  }

  const agents: LoadedAgent[] = [];
  for (const agentId of team.agents) {
    const teamAgentDir = path.join(teamDir, 'agents', agentId);
    const rootAgentDir = path.join(rootAgentsDir, agentId);

    const hasTeamManifest = fs.existsSync(path.join(teamAgentDir, 'manifest.json'));
    const hasRootManifest = fs.existsSync(path.join(rootAgentDir, 'manifest.json'));

    if (!hasTeamManifest && !hasRootManifest) {
      logger.warn({ agentId, teamId }, 'Skipping team agent — manifest not found in team dir or root agents dir');
      continue;
    }

    const agentDir = hasTeamManifest ? teamAgentDir : rootAgentDir;
    const source = hasTeamManifest ? 'team' : 'root';

    try {
      const manifest = loadManifest(agentDir);
      agents.push({ manifest, dir: agentDir, teamId });
      logger.debug({ id: manifest.id, dir: agentDir, teamId, source }, 'Team agent resolved');
    } catch (err) {
      logger.warn({ err, agentId, teamId }, 'Skipping team agent — cannot load manifest');
    }
  }

  logger.info({ count: agents.length, teamId }, 'Team agents loaded');
  return agents;
}

function scanDirectory(dir: string, agents: LoadedAgent[], depth = 0): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const agentDir = path.join(dir, entry.name);
    const manifestPath = path.join(agentDir, 'manifest.json');

    if (fs.existsSync(manifestPath)) {
      // This directory is an agent — load it
      try {
        const manifest = loadManifest(agentDir);
        agents.push({ manifest, dir: agentDir });
        logger.debug({ id: manifest.id, dir: agentDir }, 'Agent loaded');
      } catch (err) {
        logger.warn({ err, dir: agentDir }, 'Skipping agent — invalid manifest');
      }
    } else if (depth === 0) {
      // No manifest — treat as plugin group, scan one level deeper
      // Guard against broken symlinks (target might not exist in container)
      try {
        fs.readdirSync(agentDir);
      } catch {
        logger.warn({ dir: agentDir }, 'Skipping plugin group — directory not accessible (broken symlink?)');
        continue;
      }
      logger.debug({ dir: agentDir }, 'Scanning plugin group directory');
      scanDirectory(agentDir, agents, depth + 1);
    }
  }
}
