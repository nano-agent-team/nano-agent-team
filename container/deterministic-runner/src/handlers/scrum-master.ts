/**
 * Scrum-master deterministic handler.
 *
 * Runs on each alarm wakeup:
 *   1. Dispatch waiting tickets to assigned agents
 *   2. Detect orphaned in_progress tickets
 *   3. Set next alarm with adaptive interval
 */

import { StringCodec } from 'nats';
import type { Handler } from '../types.js';

interface TicketRow {
  id: string;
  title: string;
  status: string;
  assigned_to: string | null;
  updated_at: string;
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

const GRACE_PERIOD_MS = 30_000;
const MAX_ORPHAN_RECOVERIES = 3;

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

const handle: Handler = async (payload, ctx) => {
  const { agentId, db, mcp, nc, log } = ctx;
  const js = nc.jetstream();
  let workFound = false;
  let queueSize = 0;

  // ── 1. Dispatch waiting tickets ──────────────────────────────────
  const waitingTickets = db
    .prepare('SELECT id, title, status, assigned_to, updated_at FROM tickets WHERE status = ?')
    .all('waiting') as TicketRow[];

  queueSize = waitingTickets.length;

  for (const ticket of waitingTickets) {
    if (!ticket.assigned_to) continue;

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
        `agent.${ticket.assigned_to}.task`,
        codec.encode(JSON.stringify({ ticket_id: ticket.id, title: ticket.title })),
      );
      log.info({ ticketId: ticket.id, agent: ticket.assigned_to }, 'Dispatched ticket');
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
  const inProgressTickets = db
    .prepare('SELECT id, title, status, assigned_to, updated_at FROM tickets WHERE status = ?')
    .all('in_progress') as TicketRow[];

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
    const updatedAt = new Date(ticket.updated_at).getTime();
    if (now - updatedAt < GRACE_PERIOD_MS) continue;

    // Check if any running agent is working on this ticket
    const hasActiveAgent = agentStates.some(
      (a) => a.ticketId === ticket.id && a.status === 'running',
    );
    if (hasActiveAgent) continue;

    // Orphan detected
    log.warn({ ticketId: ticket.id, assignedTo: ticket.assigned_to }, 'Orphan ticket detected');

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

  // ── 3. Set next alarm with adaptive interval ─────────────────────
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
