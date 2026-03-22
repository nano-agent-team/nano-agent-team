/**
 * Tickets MCP Server for nano-agent-team
 *
 * Standalone stdio process registered as MCP server in agent-runner.
 * Provides ticket CRUD tools to agents via MCP protocol.
 *
 * Tools:
 *   tickets_list   — list tickets with optional filters
 *   ticket_get     — get single ticket with comments
 *   ticket_create  — create new ticket
 *   ticket_update  — update ticket (status, assigned_to, body, etc.)
 *   ticket_comment — add comment to ticket
 *
 * Env vars:
 *   DB_PATH  — path to SQLite DB file (mounted from host)
 *   AGENT_ID — used as default author/changed_by
 */

import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH ?? '/workspace/db/nano-agent-team.db';
const AGENT_ID = process.env.AGENT_ID ?? 'agent';

// ─── Database ─────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  // WAL mode for concurrent read access alongside host process
  try { db.pragma('journal_mode = WAL'); } catch { /* already set */ }
  return db;
}

function nextTicketId(db: Database.Database): string {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM tickets').get() as { cnt: number };
  return `TICK-${(row.cnt + 1).toString().padStart(4, '0')}`;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'tickets',
  version: '1.0.0',
});

// tickets_list
server.tool(
  'tickets_list',
  'List tickets. Use filters to narrow results. Returns id, title, status, priority, assigned_to.',
  {
    status: z.string().optional().describe('Filter by status: idea|waiting|in_progress|done|rejected'),
    priority: z.string().optional().describe('Filter by priority: CRITICAL|HIGH|MED|LOW'),
    assigned_to: z.string().optional().describe('Filter by assigned agent id'),
  },
  async ({ status, priority, assigned_to }) => {
    const db = openDb();
    let sql = 'SELECT id, title, status, priority, type, assigned_to, created_at, updated_at FROM tickets WHERE 1=1';
    const params: string[] = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (priority) { sql += ' AND priority = ?'; params.push(priority); }
    if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to); }
    sql += ' ORDER BY created_at DESC LIMIT 50';

    const tickets = db.prepare(sql).all(...params);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(tickets, null, 2),
      }],
    };
  },
);

// ticket_get
server.tool(
  'ticket_get',
  'Get a single ticket by ID, including full body (tech spec) and comments.',
  {
    ticket_id: z.string().describe('Ticket ID, e.g. TICK-0001'),
  },
  async ({ ticket_id }) => {
    const db = openDb();
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket_id);
    if (!ticket) {
      return { content: [{ type: 'text' as const, text: `Ticket ${ticket_id} not found` }], isError: true };
    }
    const comments = db
      .prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC')
      .all(ticket_id);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ticket, comments }, null, 2),
      }],
    };
  },
);

// ticket_create
server.tool(
  'ticket_create',
  'Create a new ticket. Returns the created ticket with its generated ID.',
  {
    title: z.string().describe('Ticket title'),
    status: z.string().optional().describe('Initial status (default: idea)'),
    priority: z.string().optional().describe('Priority: CRITICAL|HIGH|MED|LOW (default: MED)'),
    type: z.string().optional().describe('Type: epic|story|task|bug|idea (default: task)'),
    body: z.string().optional().describe('Ticket body / description'),
    assigned_to: z.string().optional().describe('Agent to assign to'),
  },
  async ({ title, status, priority, type, body, assigned_to }) => {
    const db = openDb();
    const id = nextTicketId(db);
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    db.prepare(`
      INSERT INTO tickets (id, title, status, priority, type, body, assigned_to, author, created_at, updated_at)
      VALUES (@id, @title, @status, @priority, @type, @body, @assigned_to, @author, @created_at, @updated_at)
    `).run({
      id,
      title,
      status: status ?? 'idea',
      priority: priority ?? 'MED',
      type: type ?? 'task',
      body: body ?? null,
      assigned_to: assigned_to ?? null,
      author: AGENT_ID,
      created_at: now,
      updated_at: now,
    });

    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }],
    };
  },
);

// ticket_update — delegates to HTTP API so NATS pipeline events are auto-published
const API_URL = process.env.API_URL ?? 'http://localhost:3001';

server.tool(
  'ticket_update',
  'Update a ticket. Can change status, assigned_to, body (tech spec), priority, etc. Status changes are logged in history and trigger pipeline events.',
  {
    ticket_id:       z.string().describe('Ticket ID to update'),
    status:          z.string().optional().describe('New status: idea|waiting|in_progress|done|rejected'),
    priority:        z.string().optional().describe('New priority: CRITICAL|HIGH|MED|LOW'),
    assigned_to:     z.string().optional().describe('New assignee agent id'),
    body:            z.string().optional().describe('New body content (replaces existing)'),
    title:           z.string().optional().describe('New title'),
    expected_status: z.string().optional().describe('Optimistic lock: only update if current status matches. Returns error on mismatch.'),
  },
  async ({ ticket_id, status, priority, assigned_to, body, title, expected_status }) => {
    const patchBody: Record<string, unknown> = { changed_by: AGENT_ID };
    if (status !== undefined) patchBody['status'] = status;
    if (priority !== undefined) patchBody['priority'] = priority;
    if (assigned_to !== undefined) patchBody['assigned_to'] = assigned_to;
    if (body !== undefined) patchBody['body'] = body;
    if (title !== undefined) patchBody['title'] = title;
    if (expected_status !== undefined) patchBody['expected_status'] = expected_status;

    try {
      const res = await fetch(`${API_URL}/api/tickets/${encodeURIComponent(ticket_id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${JSON.stringify(data)}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `HTTP error: ${err}` }], isError: true };
    }
  },
);

// ticket_comment
server.tool(
  'ticket_comment',
  'Add a comment to a ticket. Use to document decisions, link PRs, or report progress.',
  {
    ticket_id: z.string().describe('Ticket ID'),
    body: z.string().describe('Comment text'),
  },
  async ({ ticket_id, body }) => {
    const db = openDb();
    const ticket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticket_id);
    if (!ticket) {
      return { content: [{ type: 'text' as const, text: `Ticket ${ticket_id} not found` }], isError: true };
    }

    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const result = db.prepare(`
      INSERT INTO ticket_comments (ticket_id, author, body, created_at)
      VALUES (?, ?, ?, ?)
    `).run(ticket_id, AGENT_ID, body, now);

    const comment = db.prepare('SELECT * FROM ticket_comments WHERE id = ?').get(result.lastInsertRowid);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(comment, null, 2) }],
    };
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
