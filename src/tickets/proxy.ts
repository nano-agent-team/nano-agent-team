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
  private providers = new Map<string, TicketProvider>();
  /** ID of the primary provider used for createTicket when no backend is specified. */
  private primaryId: string;

  constructor(private readonly defaultProvider: TicketProvider) {
    this.primaryId = defaultProvider.id;
    this.providers.set(defaultProvider.id, defaultProvider);
  }

  registerPrefix(prefix: string, provider: TicketProvider): void {
    this.prefixes.set(prefix.toUpperCase(), provider);
    this.providers.set(provider.id, provider);
  }

  /**
   * Set the primary backend for createTicket.
   * Must match a registered provider id (e.g. "local", "github").
   */
  setPrimary(providerId: string): void {
    this.primaryId = providerId;
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

  /**
   * Create a ticket.
   * - If data.backend is specified, route to that provider explicitly.
   * - Otherwise use the configured primary provider.
   */
  async createTicket(data: CreateTicketData): Promise<Ticket> {
    const { backend, ...rest } = data;
    if (backend) {
      const provider = this.providers.get(backend);
      if (!provider) throw new Error(`TicketProxy: unknown backend '${backend}'`);
      return provider.createTicket(rest);
    }
    const primary = this.providers.get(this.primaryId) ?? this.defaultProvider;
    return primary.createTicket(rest);
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

  async addComment(ticketId: string, body: string, author: string, verdict?: string): Promise<TicketComment> {
    return this.route(ticketId).addComment(ticketId, body, author, verdict);
  }

  async getComments(ticketId: string): Promise<TicketComment[]> {
    return this.route(ticketId).getComments(ticketId);
  }

  async deleteTicket(id: string): Promise<void> {
    return this.route(id).deleteTicket?.(id);
  }
}
