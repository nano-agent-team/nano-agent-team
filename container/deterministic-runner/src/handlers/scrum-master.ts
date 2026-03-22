/**
 * Scrum-master deterministic handler.
 *
 * Runs on each alarm wakeup:
 *   1. Dispatch waiting tickets to assigned agents
 *   2. Detect orphaned in_progress tickets
 *   3. Set next alarm with adaptive interval
 */

import fs from 'fs';
import { StringCodec } from 'nats';
import type { Handler, HandlerContext } from '../types.js';

interface TicketRow {
  id: string;
  title: string;
  status: string;
  // MCP returns 'assignee', DB returns 'assigned_to' — handle both
  assignee?: string | null;
  assigned_to?: string | null;
  updatedAt?: string;
  updated_at?: string;
}

interface CommentCountRow {
  count: number;
}

interface AgentState {
  agentId: string;
  ticketId?: string;
  status: string;
}

const codec = StringCodec();

const GRACE_PERIOD_MS = 5 * 60_000; // 5 minutes — LLM agents need time to process
const MAX_ORPHAN_RECOVERIES = 3;

type PipelineRoute = { next: string | null; retry?: string };
type PipelineConfig = Record<string, PipelineRoute>;

/** Load pipeline config from agent manifest (/workspace/agent/manifest.json) */
function loadPipeline(log: HandlerContext['log']): PipelineConfig {
  const manifestPath = '/workspace/agent/manifest.json';
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { pipeline?: PipelineConfig };
    if (manifest.pipeline) {
      log.info({ routes: Object.keys(manifest.pipeline).length }, 'Loaded pipeline config from manifest');
      return manifest.pipeline;
    }
  } catch (err) {
    log.warn({ err }, 'Failed to read manifest — no pipeline routing');
  }
  return {};
}

async function callMcpTool(
  mcp: Parameters<Handler>[1]['mcp'],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await mcp.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
  if (result.isError) throw new Error(text ?? 'MCP tool error');
  return text ? JSON.parse(text) : null;
}

/** Get assignee from ticket (MCP returns 'assignee', DB returns 'assigned_to') */
function getAssignee(t: TicketRow): string | null {
  return t.assignee ?? t.assigned_to ?? null;
}
/** Get updated timestamp (MCP returns 'updatedAt', DB returns 'updated_at') */
function getUpdatedAt(t: TicketRow): string {
  return t.updatedAt ?? t.updated_at ?? '';
}

const handle: Handler = async (payload, ctx) => {
  const { agentId, db, mcp, nc, log } = ctx;
  const pipeline = loadPipeline(log);
  const js = nc.jetstream();
  let workFound = false;
  let queueSize = 0;

  // ── 1. Dispatch waiting tickets ──────────────────────────────────
  // Use MCP tickets_list (not direct DB) to see tickets from ALL providers (local + GitHub)
  let waitingTickets: TicketRow[] = [];
  try {
    const rawTickets = await callMcpTool(mcp, 'tickets_list', { status: 'waiting' }) as TicketRow[];
    waitingTickets = Array.isArray(rawTickets) ? rawTickets : [];
  } catch (err) {
    log.error({ err }, 'Failed to list waiting tickets via MCP');
  }

  queueSize = waitingTickets.length;

  // Get known agents for validation
  let knownAgents: Set<string>;
  try {
    const status = await callMcpTool(mcp, 'get_system_status', {}) as { agents?: Array<{ agentId: string }> };
    knownAgents = new Set((status?.agents ?? []).map(a => a.agentId));
  } catch {
    knownAgents = new Set();
  }

  for (const ticket of waitingTickets) {
    const assignee = getAssignee(ticket);
    if (!assignee) continue;

    // Skip if assigned_to points to unknown agent
    if (knownAgents.size > 0 && !knownAgents.has(assignee)) {
      log.warn({ ticketId: ticket.id, assignedTo: assignee }, 'Unknown agent — skipping dispatch');
      continue;
    }

    // Claim via expected_status CAS
    try {
      await callMcpTool(mcp, 'ticket_update', {
        ticket_id: ticket.id,
        status: 'in_progress',
        expected_status: 'waiting',
      });
    } catch (err) {
      // expected_status conflict — already claimed by someone else
      log.debug({ ticketId: ticket.id, err }, 'Claim failed (likely conflict), skipping');
      continue;
    }

    // Dispatch to agent via NATS
    try {
      await js.publish(
        `agent.${assignee}.task`,
        codec.encode(JSON.stringify({ ticket_id: ticket.id, title: ticket.title })),
      );
      log.info({ ticketId: ticket.id, agent: assignee }, 'Dispatched ticket');
      workFound = true;
    } catch (err) {
      // Revert claim on dispatch failure
      log.error({ ticketId: ticket.id, err }, 'Dispatch failed, reverting claim');
      try {
        await callMcpTool(mcp, 'ticket_update', {
          ticket_id: ticket.id,
          status: 'waiting',
        });
      } catch (revertErr) {
        log.error({ ticketId: ticket.id, revertErr }, 'Failed to revert claim');
      }
    }
  }

  // ── 2. Orphan detection ──────────────────────────────────────────
  let inProgressTickets: TicketRow[] = [];
  try {
    const rawInProgress = await callMcpTool(mcp, 'tickets_list', { status: 'in_progress' }) as TicketRow[];
    inProgressTickets = Array.isArray(rawInProgress) ? rawInProgress : [];
  } catch (err) {
    log.error({ err }, 'Failed to list in_progress tickets via MCP');
  }

  // Get system status once for all orphan checks
  let agentStates: AgentState[] = [];
  if (inProgressTickets.length > 0) {
    try {
      const statusResult = await callMcpTool(mcp, 'get_system_status', {});
      const statusData = statusResult as { agents?: AgentState[] } | null;
      agentStates = statusData?.agents ?? [];
    } catch (err) {
      log.warn({ err }, 'Failed to get system status for orphan detection');
    }
  }

  const now = Date.now();

  for (const ticket of inProgressTickets) {
    // Grace period: skip recently updated tickets
    const updatedAt = new Date(getUpdatedAt(ticket)).getTime();
    if (now - updatedAt < GRACE_PERIOD_MS) continue;

    const orphanAssignee = getAssignee(ticket);

    // Check if the assigned agent type is alive (running and responsive)
    const assignedAgentAlive = agentStates.some(
      (a) => a.agentId === orphanAssignee && a.status === 'running',
    );
    if (assignedAgentAlive) continue;

    // Orphan detected
    log.warn({ ticketId: ticket.id, assignedTo: orphanAssignee }, 'Orphan ticket detected');

    // Count previous recoveries
    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM ticket_comments WHERE ticket_id = ? AND body LIKE 'Orphan recovery%'")
      .get(ticket.id) as CommentCountRow | undefined;
    const recoveryCount = countRow?.count ?? 0;

    if (recoveryCount >= MAX_ORPHAN_RECOVERIES) {
      // Too many recoveries — reject the ticket
      try {
        await callMcpTool(mcp, 'ticket_update', {
          ticket_id: ticket.id,
          status: 'rejected',
        });
        await callMcpTool(mcp, 'ticket_update', {
          ticket_id: ticket.id,
          comment: `Orphan recovery limit reached (${MAX_ORPHAN_RECOVERIES}). Ticket rejected after repeated agent failures.`,
        });
        log.info({ ticketId: ticket.id, recoveryCount }, 'Orphan ticket rejected (max recoveries)');
      } catch (err) {
        log.error({ ticketId: ticket.id, err }, 'Failed to reject orphan ticket');
      }
    } else {
      // Revert to waiting for re-dispatch
      try {
        await callMcpTool(mcp, 'ticket_update', {
          ticket_id: ticket.id,
          status: 'waiting',
          comment: `Orphan recovery #${recoveryCount + 1}: no active agent found, reverting to waiting.`,
        });
        log.info({ ticketId: ticket.id, recoveryCount: recoveryCount + 1 }, 'Orphan ticket reverted to waiting');
        workFound = true;
      } catch (err) {
        log.error({ ticketId: ticket.id, err }, 'Failed to revert orphan ticket');
      }
    }
  }

  // ── 3. Route done tickets (deterministic handoff) ───────────────
  if (Object.keys(pipeline).length > 0) {
    let doneTickets: TicketRow[] = [];
    try {
      const rawDone = await callMcpTool(mcp, 'tickets_list', { status: 'done' }) as TicketRow[];
      doneTickets = Array.isArray(rawDone) ? rawDone : [];
    } catch (err) {
      log.error({ err }, 'Failed to list done tickets');
    }

    for (const ticket of doneTickets) {
      const completedBy = getAssignee(ticket);
      if (!completedBy) continue;

      const route = pipeline[completedBy];
      if (!route) continue; // Agent not in pipeline config — skip

      // Read last comment verdict via ticket_get (includes comments)
      let verdict: string | undefined;
      try {
        const ticketData = await callMcpTool(mcp, 'ticket_get', { ticket_id: ticket.id }) as {
          comments?: Array<{ verdict?: string }>;
        };
        const lastComment = ticketData?.comments?.slice(-1)[0];
        verdict = lastComment?.verdict ?? undefined;
      } catch { /* ignore — default to next */ }

      if (verdict === 'rejected') {
        try {
          await callMcpTool(mcp, 'ticket_update', { ticket_id: ticket.id, status: 'rejected', expected_status: 'done' });
          log.info({ ticketId: ticket.id, completedBy, verdict }, 'Pipeline: ticket rejected');
        } catch { /* ignore */ }
        continue;
      }

      const nextAgent = (verdict === 'rework' && route.retry) ? route.retry : route.next;

      if (!nextAgent) {
        // Pipeline complete — leave as done
        log.info({ ticketId: ticket.id, completedBy }, 'Pipeline complete');
        continue;
      }

      // Route to next agent
      try {
        await callMcpTool(mcp, 'ticket_update', {
          ticket_id: ticket.id,
          status: 'waiting',
          assignee: nextAgent,
          expected_status: 'done',
        });
        log.info({ ticketId: ticket.id, from: completedBy, to: nextAgent, verdict: verdict ?? 'default' }, 'Pipeline: routed done ticket');
        workFound = true;
      } catch (err) {
        log.warn({ ticketId: ticket.id, err }, 'Failed to route done ticket');
      }
    }
  }

  // ── 4. Set next alarm with adaptive interval ─────────────────────
  let interval: number;
  if (queueSize > 5) {
    interval = 15;
  } else if (workFound) {
    interval = 30;
  } else {
    interval = 300;
  }

  try {
    await callMcpTool(mcp, 'alarm_set', {
      agent_id: agentId,
      delay_seconds: interval,
      payload: { type: 'poll' },
    });
    log.info({ interval, queueSize, workFound }, 'Next alarm set');
  } catch (err) {
    log.error({ err }, 'Failed to set next alarm');
  }
};

export default handle;
