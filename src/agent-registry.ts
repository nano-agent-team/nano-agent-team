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
}

export interface LoadedAgent {
  manifest: AgentManifest;
  /** Absolute path to the agent directory */
  dir: string;
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
