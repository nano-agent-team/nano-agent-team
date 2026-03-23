/**
 * Soul Dispatcher — deterministic Obsidian → NATS bridge.
 *
 * Periodically scans /data/obsidian/Consciousness/ for state changes
 * and dispatches NATS messages. No LLM involved — pure file-based state machine.
 *
 * Responsibilities:
 *   - ideas with status: pending_review → publish soul.idea.pending
 *   - ideas with conscience_verdict: approved → publish soul.idea.approved
 *   - ideas with conscience_verdict: rejected → publish soul.idea.rejected
 *   - plans with status: pending → publish soul.plan.ready
 *   - auto-set alarms for persistent base agents on startup
 */

import fs from 'fs';
import path from 'path';
import { type NatsConnection } from 'nats';
import { publish } from './nats-client.js';
import { logger } from './logger.js';

const SCAN_INTERVAL_MS = 10_000; // 10 seconds

interface IdeaFrontmatter {
  id: string;
  status: string;
  conscience_verdict?: string;
  conscience_reason?: string;
}

interface PlanFrontmatter {
  id: string;
  status: string;
  idea: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}

export class SoulDispatcher {
  private nc: NatsConnection;
  private obsidianDir: string;
  private dispatched = new Set<string>(); // track already-dispatched actions to avoid duplicates
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(nc: NatsConnection, dataDir: string) {
    this.nc = nc;
    this.obsidianDir = path.join(dataDir, 'obsidian', 'Consciousness');
  }

  start(): void {
    logger.info('SoulDispatcher started — scanning every %dms', SCAN_INTERVAL_MS);
    // Initial scan after short delay (let agents start first)
    setTimeout(() => this.scan(), 5000);
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private scan(): void {
    try {
      this.scanIdeas();
      this.scanPlans();
    } catch (err) {
      logger.error({ err }, 'SoulDispatcher scan error');
    }
  }

  private scanIdeas(): void {
    const ideasDir = path.join(this.obsidianDir, 'ideas');
    if (!fs.existsSync(ideasDir)) return;

    for (const file of fs.readdirSync(ideasDir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(ideasDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content) as unknown as IdeaFrontmatter;
      if (!fm.id) continue;

      const obsidianPath = `/obsidian/Consciousness/ideas/${file}`;

      // pending_review → dispatch to conscience
      if (fm.status === 'pending_review' && !fm.conscience_verdict) {
        const key = `idea.pending:${fm.id}`;
        if (!this.dispatched.has(key)) {
          this.dispatched.add(key);
          void publish(this.nc, 'soul.idea.pending', JSON.stringify({ ideaId: fm.id, path: obsidianPath }));
          logger.info({ ideaId: fm.id }, 'SoulDispatcher: idea pending → conscience');
        }
      }

      // conscience approved → dispatch to strategist
      if (fm.conscience_verdict === 'approved' && fm.status !== 'in_progress' && fm.status !== 'done') {
        const key = `idea.approved:${fm.id}`;
        if (!this.dispatched.has(key)) {
          this.dispatched.add(key);
          // Update status to approved if conscience just approved
          if (fm.status === 'pending_review') {
            const updated = content.replace(/status:\s*pending_review/, 'status: approved');
            fs.writeFileSync(filePath, updated);
          }
          void publish(this.nc, 'soul.idea.approved', JSON.stringify({ ideaId: fm.id, path: obsidianPath }));
          logger.info({ ideaId: fm.id }, 'SoulDispatcher: idea approved → strategist');
        }
      }

      // conscience rejected → notify consciousness
      if (fm.conscience_verdict === 'rejected') {
        const key = `idea.rejected:${fm.id}`;
        if (!this.dispatched.has(key)) {
          this.dispatched.add(key);
          void publish(this.nc, 'soul.idea.rejected', JSON.stringify({
            ideaId: fm.id,
            path: obsidianPath,
            reason: fm.conscience_reason ?? 'No reason provided',
          }));
          logger.info({ ideaId: fm.id }, 'SoulDispatcher: idea rejected → consciousness');
        }
      }
    }
  }

  private scanPlans(): void {
    const plansDir = path.join(this.obsidianDir, 'plans');
    if (!fs.existsSync(plansDir)) return;

    for (const file of fs.readdirSync(plansDir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(plansDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content) as unknown as PlanFrontmatter;
      if (!fm.id) continue;

      const obsidianPath = `/obsidian/Consciousness/plans/${file}`;

      // pending plan → dispatch to foreman
      if (fm.status === 'pending') {
        const key = `plan.ready:${fm.id}`;
        if (!this.dispatched.has(key)) {
          this.dispatched.add(key);
          void publish(this.nc, 'soul.plan.ready', JSON.stringify({ planId: fm.id, path: obsidianPath }));
          logger.info({ planId: fm.id }, 'SoulDispatcher: plan ready → foreman');
        }
      }
    }
  }
}
