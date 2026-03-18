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

export interface AgentManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  model?: string;
  /** NATS subjects the agent subscribes to */
  subscribe_topics: string[];
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
  /** Mount host SSH keys (~/.ssh) into container for git SSH access */
  ssh_mount?: boolean;
  /** Capability tags for auto model selection: 'fast', 'cheap', 'reasoning', 'long-context', ... */
  capabilities?: string[];
  /** LLM provider: provider name or 'auto' (default: 'auto' = use primaryProvider) */
  provider?: string;
}

export interface LoadedAgent {
  manifest: AgentManifest;
  /** Absolute path to the agent directory */
  dir: string;
  /** Team ID when agent is loaded in team context (enables per-team container naming) */
  teamId?: string;
}

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
  if (!Array.isArray(m.subscribe_topics) || m.subscribe_topics.length === 0) {
    throw new Error(`manifest.json in ${agentDir}: "subscribe_topics" must be a non-empty array`);
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
