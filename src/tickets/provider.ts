/**
 * TicketProvider — the interface every ticket backend must implement.
 *
 * Implementations: LocalTicketProvider (SQLite), GitHubIssuesProvider, ...
 * Routing across multiple providers: TicketProxy
 */

import type {
  Ticket,
  TicketComment,
  CreateTicketData,
  UpdateTicketData,
  TicketFilters,
  AbstractStatus,
} from './types.js';

// ─── StatusMapper ─────────────────────────────────────────────────────────────

/**
 * Translates between the abstract status model and a provider's native
 * representation (e.g. GitHub labels, Jira transitions, DB strings).
 */
export interface StatusMapper<NativeStatus = string> {
  toNative(abstract: AbstractStatus): NativeStatus;
  fromNative(native: NativeStatus): AbstractStatus;
}

// ─── TicketProvider ───────────────────────────────────────────────────────────

export interface TicketProvider {
  readonly id: string;
  readonly displayName: string;

  createTicket(data: CreateTicketData): Promise<Ticket>;
  getTicket(id: string): Promise<Ticket | null>;
  updateTicket(id: string, data: UpdateTicketData, changedBy?: string): Promise<Ticket>;
  listTickets(filters?: TicketFilters): Promise<Ticket[]>;
  addComment(ticketId: string, body: string, author: string, verdict?: string): Promise<TicketComment>;
  getComments(ticketId: string): Promise<TicketComment[]>;

  /** Optional: some providers support hard deletion (e.g. close a GitHub issue) */
  deleteTicket?(id: string): Promise<void>;
}
