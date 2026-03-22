/**
 * LocalTicketProvider — SQLite-backed implementation of TicketProvider.
 *
 * Wraps the existing db.ts functions and maps between the DB schema
 * (snake_case, flat strings) and the abstract Ticket model.
 */

import type { TicketProvider, StatusMapper } from './provider.js';
import type {
  Ticket,
  TicketComment,
  CreateTicketData,
  UpdateTicketData,
  TicketFilters,
  AbstractStatus,
  TicketPriority,
  TicketType,
} from './types.js';
import {
  openDb,
  nextTicketId,
  type Ticket as DbTicket,
  type TicketComment as DbComment,
} from '../db.js';

// ─── Local status mapper (1:1) ────────────────────────────────────────────────

/**
 * The local DB stores the same values as the abstract model (1:1 mapping).
 * Statuses: idea, waiting, in_progress, done, rejected.
 */
export class LocalStatusMapper implements StatusMapper<string> {
  toNative(abstract: AbstractStatus): string {
    return abstract;
  }

  toAbstract(native: string): AbstractStatus {
    return native as AbstractStatus;
  }

  fromNative(native: string): AbstractStatus {
    return native as AbstractStatus;
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

const statusMapper = new LocalStatusMapper();

function dbToTicket(row: DbTicket): Ticket {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: statusMapper.fromNative(row.status),
    priority: row.priority as TicketPriority,
    type: row.type as TicketType,
    assignee: row.assigned_to,
    author: row.author,
    labels: row.labels ? row.labels.split(',').map(l => l.trim()).filter(Boolean) : [],
    parentId: row.parent_id,
    blockedBy: row.blocked_by,
    modelHint: row.model_hint,
    provider: 'local',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dbCommentToComment(row: DbComment): TicketComment {
  return {
    id: String(row.id),
    ticketId: row.ticket_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  };
}

// ─── LocalTicketProvider ──────────────────────────────────────────────────────

export class LocalTicketProvider implements TicketProvider {
  readonly id = 'local';
  readonly displayName = 'Local (SQLite)';

  async createTicket(data: CreateTicketData): Promise<Ticket> {
    const db = openDb();
    const id = nextTicketId();
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    db.prepare(`
      INSERT INTO tickets
        (id, title, status, priority, type, parent_id, blocked_by, author, assigned_to, labels, body, created_at, updated_at)
      VALUES
        (@id, @title, @status, @priority, @type, @parent_id, @blocked_by, @author, @assigned_to, @labels, @body, @created_at, @updated_at)
    `).run({
      id,
      title: data.title,
      status: statusMapper.toNative('idea'),
      priority: data.priority ?? 'MED',
      type: data.type ?? 'task',
      parent_id: data.parentId ?? null,
      blocked_by: null,
      author: data.author ?? null,
      assigned_to: data.assignee ?? null,
      labels: data.labels?.join(',') ?? null,
      body: data.body ?? null,
      created_at: now,
      updated_at: now,
    });

    return dbToTicket(db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as DbTicket);
  }

  async getTicket(id: string): Promise<Ticket | null> {
    const db = openDb();
    const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as DbTicket | undefined;
    return row ? dbToTicket(row) : null;
  }

  async updateTicket(id: string, data: UpdateTicketData, changedBy?: string): Promise<Ticket> {
    const db = openDb();
    const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as DbTicket | undefined;
    if (!existing) throw new Error(`Ticket ${id} not found`);

    // Optimistic lock (GH-103): reject if current status doesn't match expected
    if (data.expected_status !== undefined) {
      const expectedNative = statusMapper.toNative(data.expected_status);
      if (existing.status !== expectedNative) {
        const err = new Error(`Status conflict: expected '${data.expected_status}' but found '${statusMapper.toAbstract(existing.status)}'`);
        (err as any).statusCode = 409;
        throw err;
      }
    }

    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const updates: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: now };

    if (data.title !== undefined)    { updates.push('title = @title');           params.title = data.title; }
    if (data.body !== undefined)     { updates.push('body = @body');             params.body = data.body; }
    if (data.status !== undefined)   { updates.push('status = @status');         params.status = statusMapper.toNative(data.status); }
    if (data.priority !== undefined) { updates.push('priority = @priority');     params.priority = data.priority; }
    if (data.assignee !== undefined) { updates.push('assigned_to = @assigned_to'); params.assigned_to = data.assignee; }
    if (data.labels !== undefined)   { updates.push('labels = @labels');         params.labels = data.labels.join(','); }

    db.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE id = @id`).run(params);

    // Record history if status changed
    if (data.status !== undefined) {
      const nativeNew = statusMapper.toNative(data.status);
      if (nativeNew !== existing.status) {
        db.prepare(`
          INSERT INTO ticket_history (ticket_id, from_status, to_status, changed_by, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, existing.status, nativeNew, changedBy ?? null, now);
      }
    }

    return dbToTicket(db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as DbTicket);
  }

  async listTickets(filters: TicketFilters = {}): Promise<Ticket[]> {
    const db = openDb();
    let sql = 'SELECT * FROM tickets WHERE 1=1';
    const params: string[] = [];

    if (filters.status) {
      sql += ' AND status = ?';
      params.push(statusMapper.toNative(filters.status));
    }
    if (filters.priority) {
      sql += ' AND priority = ?';
      params.push(filters.priority);
    }
    if (filters.assignee) {
      sql += ' AND assigned_to = ?';
      params.push(filters.assignee);
    }

    sql += ' ORDER BY created_at DESC';
    return (db.prepare(sql).all(...params) as DbTicket[]).map(dbToTicket);
  }

  async addComment(ticketId: string, body: string, author: string): Promise<TicketComment> {
    const db = openDb();
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const result = db.prepare(`
      INSERT INTO ticket_comments (ticket_id, author, body, created_at)
      VALUES (?, ?, ?, ?)
    `).run(ticketId, author, body, now);

    return dbCommentToComment(
      db.prepare('SELECT * FROM ticket_comments WHERE id = ?').get(result.lastInsertRowid) as DbComment,
    );
  }

  async getComments(ticketId: string): Promise<TicketComment[]> {
    const db = openDb();
    return (db
      .prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC')
      .all(ticketId) as DbComment[]
    ).map(dbCommentToComment);
  }
}
