/**
 * TicketRegistry — routes ticket operations to the correct provider
 * and fires NATS pipeline events on status transitions.
 *
 * Usage:
 *   const registry = new TicketRegistry(nc);
 *   registry.registerGlobal(new LocalTicketProvider());
 *   registry.registerTeam('github-team', new GitHubIssuesProvider(...));
 *
 *   await registry.updateTicket('TICK-0001', { status: 'approved' });
 *   // → publishes to topic.ticket.approved automatically
 */

import type { NatsConnection } from 'nats';

import { logger } from '../logger.js';
import { publish } from '../nats-client.js';
import type { TicketProvider } from './provider.js';
import { TicketProxy } from './proxy.js';
import type {
  Ticket,
  TicketComment,
  CreateTicketData,
  UpdateTicketData,
  TicketFilters,
} from './types.js';
import { STATUS_NATS_EVENTS } from './types.js';

export class TicketRegistry {
  private global?: TicketProvider;
  private teams = new Map<string, TicketProvider>();

  constructor(private readonly nc?: NatsConnection) {}

  registerGlobal(provider: TicketProvider): void {
    this.global = provider;
    logger.info({ providerId: provider.id }, 'TicketRegistry: global provider registered');
  }

  registerTeam(teamId: string, provider: TicketProvider): void {
    this.teams.set(teamId, provider);
    logger.info({ teamId, providerId: provider.id }, 'TicketRegistry: team provider registered');
  }

  /**
   * Register a prefix-routed provider on the global TicketProxy.
   * The global provider must be a TicketProxy instance.
   * Example: registerPrefix('GH', githubProvider) — routes GH-42 → GitHub Issues
   */
  registerPrefix(prefix: string, provider: TicketProvider): void {
    if (!(this.global instanceof TicketProxy)) {
      throw new Error('TicketRegistry.registerPrefix: global provider must be a TicketProxy');
    }
    this.global.registerPrefix(prefix, provider);
    logger.info({ prefix, providerId: provider.id }, 'TicketRegistry: prefix provider registered');
  }

  /**
   * Set the primary backend for createTicket on the global TicketProxy.
   * Example: setPrimary('github') — new tickets go to GitHub Issues by default
   */
  setPrimary(providerId: string): void {
    if (!(this.global instanceof TicketProxy)) {
      throw new Error('TicketRegistry.setPrimary: global provider must be a TicketProxy');
    }
    this.global.setPrimary(providerId);
    logger.info({ providerId }, 'TicketRegistry: primary backend set');
  }

  getProvider(teamId?: string): TicketProvider {
    if (teamId) {
      const team = this.teams.get(teamId);
      if (team) return team;
    }
    if (this.global) return this.global;
    throw new Error('TicketRegistry: no provider registered');
  }

  // ── Delegating methods with NATS hooks ─────────────────────────────────────

  async createTicket(data: CreateTicketData, teamId?: string): Promise<Ticket> {
    const ticket = await this.getProvider(teamId).createTicket(data);
    // Notify pipeline that a new ticket is ready for PM
    if (this.nc) {
      await publish(this.nc, 'topic.ticket.new', JSON.stringify({ ticket_id: ticket.id }));
      logger.info({ ticket_id: ticket.id }, 'TicketRegistry: topic.ticket.new published');
    }
    return ticket;
  }

  async getTicket(id: string, teamId?: string): Promise<Ticket | null> {
    return this.getProvider(teamId).getTicket(id);
  }

  async updateTicket(
    id: string,
    data: UpdateTicketData,
    changedBy?: string,
    teamId?: string,
  ): Promise<Ticket> {
    const provider = this.getProvider(teamId);

    // Capture previous status before update (for transition detection)
    const previous = await provider.getTicket(id);
    const previousStatus = previous?.status;

    const updated = await provider.updateTicket(id, data, changedBy);

    // Fire NATS pipeline event if status transitioned to a mapped value
    if (
      data.status &&
      data.status !== previousStatus &&
      STATUS_NATS_EVENTS[data.status]
    ) {
      const subject = STATUS_NATS_EVENTS[data.status]!;
      const payload = { ticket_id: id, status: data.status, changed_by: changedBy };
      if (this.nc) {
        await publish(this.nc, subject, JSON.stringify(payload));
        logger.info({ subject, ticket_id: id, status: data.status }, 'TicketRegistry: pipeline event published');
      }
    }

    return updated;
  }

  async listTickets(filters?: TicketFilters, teamId?: string): Promise<Ticket[]> {
    return this.getProvider(teamId).listTickets(filters);
  }

  async addComment(ticketId: string, body: string, author: string, teamId?: string): Promise<TicketComment> {
    return this.getProvider(teamId).addComment(ticketId, body, author);
  }

  async getComments(ticketId: string, teamId?: string): Promise<TicketComment[]> {
    return this.getProvider(teamId).getComments(ticketId);
  }
}
