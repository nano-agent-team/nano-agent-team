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
import { codec } from '../nats-client.js';
import type { TicketProvider } from './provider.js';
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
    return this.getProvider(teamId).createTicket(data);
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
        this.nc.publish(subject, codec.encode(JSON.stringify(payload)));
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
