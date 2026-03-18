/**
 * Workflow Registry
 *
 * Loads WorkflowManifest from a team directory.
 * Reads workflow.json if present; falls back to team.json pipeline.topics as a compat shim.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import type { WorkflowManifest } from './agent-registry.js';

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
