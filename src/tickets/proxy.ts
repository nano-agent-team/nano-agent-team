/**
 * TicketProxy — hybrid routing across multiple TicketProvider implementations.
 *
 * Routes based on ticket ID prefix:
 *   "GH-42"    → provider registered for prefix "GH"
 *   "TICK-0001" → provider registered for prefix "TICK" (or default)
 *
 * Implements TicketProvider itself — callers don't know what's behind it.
 *
 * Usage:
 *   const proxy = new TicketProxy(localProvider);           // default
 *   proxy.registerPrefix('GH', githubProvider);
 *   const ticket = await proxy.getTicket('GH-42');         // → GitHub
 *   const ticket = await proxy.getTicket('TICK-0001');     // → local
 */

import type { TicketProvider } from './provider.js';
import type {
  Ticket,
  TicketComment,
  CreateTicketData,
  UpdateTicketData,
  TicketFilters,
} from './types.js';

export class TicketProxy implements TicketProvider {
  readonly id = 'proxy';
  readonly displayName = 'Ticket Proxy';

  private prefixes = new Map<string, TicketProvider>();

  constructor(private readonly defaultProvider: TicketProvider) {}

  registerPrefix(prefix: string, provider: TicketProvider): void {
    this.prefixes.set(prefix.toUpperCase(), provider);
  }

  private route(ticketId: string): TicketProvider {
    const dash = ticketId.indexOf('-');
    if (dash > 0) {
      const prefix = ticketId.slice(0, dash).toUpperCase();
      const provider = this.prefixes.get(prefix);
      if (provider) return provider;
    }
    return this.defaultProvider;
  }

  // createTicket always goes to default provider
  async createTicket(data: CreateTicketData): Promise<Ticket> {
    return this.defaultProvider.createTicket(data);
  }

  async getTicket(id: string): Promise<Ticket | null> {
    return this.route(id).getTicket(id);
  }

  async updateTicket(id: string, data: UpdateTicketData, changedBy?: string): Promise<Ticket> {
    return this.route(id).updateTicket(id, data, changedBy);
  }

  async listTickets(filters?: TicketFilters): Promise<Ticket[]> {
    // Aggregate across all providers
    const results = await Promise.all([
      this.defaultProvider.listTickets(filters),
      ...[...this.prefixes.values()].map(p => p.listTickets(filters)),
    ]);
    return results.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async addComment(ticketId: string, body: string, author: string): Promise<TicketComment> {
    return this.route(ticketId).addComment(ticketId, body, author);
  }

  async getComments(ticketId: string): Promise<TicketComment[]> {
    return this.route(ticketId).getComments(ticketId);
  }

  async deleteTicket(id: string): Promise<void> {
    return this.route(id).deleteTicket?.(id);
  }
}
