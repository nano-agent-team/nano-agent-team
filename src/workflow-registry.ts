/**
 * Workflow Registry
 *
 * Loads WorkflowManifest from a team directory.
 * Reads workflow.json if present; falls back to team.json pipeline.topics as a compat shim.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { loadManifest } from './agent-registry.js';
import type { WorkflowManifest, LoadedAgent } from './agent-registry.js';

/**
 * Load a WorkflowManifest from the given team directory.
 *
 * Resolution order:
 * 1. workflow.json (new format — explicit agent bindings)
 * 2. team.json pipeline.topics (legacy shim — builds a WorkflowManifest with no bindings)
 * 3. null (neither exists or both unparseable)
 */
export function loadWorkflow(teamDir: string): WorkflowManifest | null {
  // 1. Try workflow.json (new format)
  const workflowPath = path.join(teamDir, 'workflow.json');
  if (fs.existsSync(workflowPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(workflowPath, 'utf8')) as WorkflowManifest;
      logger.debug({ teamDir, workflowId: manifest.id }, 'Loaded workflow.json');
      return manifest;
    } catch (err) {
      logger.warn({ err, teamDir }, 'Cannot parse workflow.json — trying team.json fallback');
    }
  }

  // 2. Fall back to team.json — build a minimal WorkflowManifest from pipeline.topics
  const teamPath = path.join(teamDir, 'team.json');
  if (fs.existsSync(teamPath)) {
    try {
      const team = JSON.parse(fs.readFileSync(teamPath, 'utf8')) as {
        id: string;
        name: string;
        version?: string;
        agents?: string[];
        pipeline?: { topics?: Record<string, string> };
      };

      if (team.pipeline?.topics) {
        logger.debug({ teamDir, teamId: team.id }, 'Using team.json pipeline as workflow fallback');
        return {
          id: team.id,
          name: team.name,
          version: team.version ?? '0.1.0',
          agents: team.agents ?? [],
          pipeline: { topics: team.pipeline.topics },
          // No bindings — agents still use their manifest.subscribe_topics
        };
      }
    } catch (err) {
      logger.warn({ err, teamDir }, 'Cannot parse team.json for workflow fallback');
    }
  }

  return null;
}

/**
 * Expand a WorkflowManifest into a flat list of LoadedAgent instances.
 *
 * - workflow.instances present: use it (competing pools + named clones)
 * - workflow.instances absent: fallback — one instance per agent in workflow.agents
 */
export function expandInstances(
  workflow: WorkflowManifest,
  teamAgentsDir: string,
  rootAgentsDir?: string,
): LoadedAgent[] {
  const agents: LoadedAgent[] = [];

  if (workflow.instances) {
    // ── Explicit instances block ───────────────────────────────────────────────
    for (const [instanceId, instance] of Object.entries(workflow.instances)) {
      const agentDir = resolveAgentDir(instance.manifest, teamAgentsDir, rootAgentsDir);
      if (!agentDir) {
        logger.warn({ instanceId, manifest: instance.manifest }, 'expandInstances: agent manifest dir not found — skipping');
        continue;
      }

      let manifest: ReturnType<typeof loadManifest>;
      try {
        manifest = loadManifest(agentDir);
      } catch (err) {
        logger.warn({ err, instanceId }, 'expandInstances: cannot load manifest — skipping');
        continue;
      }

      const count = instance.count ?? 1;

      if (count > 1) {
        // Competing pool: N containers share a single JetStream consumer (manifest.id)
        for (let i = 1; i <= count; i++) {
          const poolInstanceId = `${instanceId}-${i}`;
          agents.push({
            manifest,
            dir: agentDir,
            instanceId: poolInstanceId,
            consumerName: instance.manifest,   // shared consumer name = manifest.id
            vaultId: instance.vault ?? poolInstanceId,
            binding: workflow.bindings?.[instanceId],
          });
        }
      } else {
        agents.push({
          manifest,
          dir: agentDir,
          instanceId,
          consumerName: instanceId,
          vaultId: instance.vault ?? instanceId,
          binding: workflow.bindings?.[instanceId],
        });
      }
    }

    // ── Apply broadcast dispatch: add subject to binding inputs of target instances ──
    if (workflow.dispatch) {
      for (const [subject, dispatchConfig] of Object.entries(workflow.dispatch)) {
        if (dispatchConfig.strategy === 'broadcast') {
          for (const agent of agents) {
            const agentInstanceId = agent.instanceId ?? agent.manifest.id;
            if (dispatchConfig.to.includes(agentInstanceId)) {
              const existingInputs = agent.binding?.inputs ?? {};
              // Add subject as an input port if not already present (copy, never mutate in-place)
              if (!Object.values(existingInputs).includes(subject)) {
                agent.binding = {
                  ...agent.binding,
                  inputs: {
                    ...existingInputs,
                    [`_broadcast_${subject.replace(/\./g, '_')}`]: subject,
                  },
                };
              }
            }
          }
        }
      }
    }
  } else {
    // ── Fallback: one instance per agent in workflow.agents ───────────────────
    for (const agentId of workflow.agents) {
      const agentDir = resolveAgentDir(agentId, teamAgentsDir, rootAgentsDir);
      if (!agentDir) {
        logger.warn({ agentId }, 'expandInstances fallback: agent dir not found — skipping');
        continue;
      }

      let manifest: ReturnType<typeof loadManifest>;
      try {
        manifest = loadManifest(agentDir);
      } catch (err) {
        logger.warn({ err, agentId }, 'expandInstances fallback: cannot load manifest — skipping');
        continue;
      }

      agents.push({
        manifest,
        dir: agentDir,
        instanceId: manifest.id,
        consumerName: manifest.id,
        binding: workflow.bindings?.[manifest.id],
      });
    }
  }

  logger.info({ count: agents.length, workflowId: workflow.id }, 'Workflow instances expanded');
  return agents;
}

function resolveAgentDir(
  manifestId: string,
  _teamAgentsDir: string,
  rootAgentsDir?: string,
): string | null {
  // All agents live in /data/agents/ (rootAgentsDir) — no per-team agents subdir.
  if (rootAgentsDir) {
    const rootDir = path.join(rootAgentsDir, manifestId);
    if (fs.existsSync(path.join(rootDir, 'manifest.json'))) return rootDir;
  }
  return null;
}
