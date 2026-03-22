/**
 * Ticket Provider — shared types
 *
 * Agents always work with the abstract model. Providers translate
 * to/from their native representation.
 */

// ─── Abstract status model ────────────────────────────────────────────────────

export type AbstractStatus =
  | 'idea'
  | 'waiting'
  | 'in_progress'
  | 'done'
  | 'rejected';

export type TicketPriority = 'CRITICAL' | 'HIGH' | 'MED' | 'LOW';
export type TicketType = 'epic' | 'story' | 'task' | 'bug' | 'idea';

// ─── Core entities ────────────────────────────────────────────────────────────

export interface Ticket {
  id: string;
  title: string;
  body?: string | null;
  status: AbstractStatus;
  priority: TicketPriority;
  type: TicketType;
  assignee?: string | null;
  author?: string | null;
  labels?: string[];
  parentId?: string | null;
  blockedBy?: string | null;
  modelHint?: string | null;
  provider: string;           // "local" | "github" | ...
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  author: string;
  body: string;
  createdAt: string;
}

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateTicketData {
  title: string;
  body?: string;
  priority?: TicketPriority;
  type?: TicketType;
  author?: string;
  assignee?: string;
  labels?: string[];
  parentId?: string;
  /**
   * Explicit backend to create the ticket in.
   * If omitted, TicketProxy uses the configured primary backend.
   * Examples: "local", "github", "jira"
   */
  backend?: string;
}

export interface UpdateTicketData {
  title?: string;
  body?: string;
  status?: AbstractStatus;
  priority?: TicketPriority;
  assignee?: string;
  labels?: string[];
  /** Optimistic lock: only update if current status matches (GH-103). Returns 409 on mismatch. */
  expected_status?: AbstractStatus;
}

export interface TicketFilters {
  status?: AbstractStatus;
  priority?: TicketPriority;
  assignee?: string;
}

// ─── Status → NATS event mapping ─────────────────────────────────────────────

/**
 * When a ticket transitions to one of these statuses, the registry
 * automatically publishes the corresponding NATS subject.
 */
export const STATUS_NATS_EVENTS: Partial<Record<AbstractStatus, string>> = {
  waiting:     'topic.ticket.waiting',
  in_progress: 'topic.ticket.claimed',
  done:        'topic.ticket.done',
  rejected:    'topic.ticket.rejected',
};
