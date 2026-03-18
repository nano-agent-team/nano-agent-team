/**
 * MCP Gateway — HTTP MCP server with per-agent ACL.
 *
 * Runs inside nate on a dedicated port (default: 3003).
 * Agent containers connect via: http://host.docker.internal:3003/mcp
 *
 * Each request carries X-Agent-ID header.
 * Available tools are filtered based on agent manifest's mcp_permissions.
 *
 * Tool namespaces:
 *   tickets — CRUD operations via TicketRegistry (with NATS pipeline events)
 *
 * Permission examples (manifest.json):
 *   "mcp_permissions": { "tickets": ["get", "list", "comment", "approve"] }
 *   "mcp_permissions": { "tickets": "*" }   // all tools
 *   (omitted)                               // all tools (backward compat)
 */

import http from 'http';

import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { logger } from './logger.js';
import type { TicketRegistry } from './tickets/registry.js';
import type { AbstractStatus, TicketPriority, TicketType } from './tickets/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type PermissionMap = Record<string, string[] | '*'>;

/** Called by gateway to resolve permissions for a given agent ID */
type PermissionResolver = (agentId: string) => PermissionMap;

// ─── Tool definitions ─────────────────────────────────────────────────────────

/** All ticket tool names and the required permission to call them */
const TICKET_TOOL_PERMISSIONS: Record<string, string> = {
  tickets_list:    'list',
  ticket_get:      'get',
  ticket_create:   'create',
  ticket_update:   'update',
  ticket_approve:  'approve',
  ticket_reject:   'reject',
  ticket_comment:  'comment',
};

function canCall(permissions: PermissionMap, namespace: string, toolName: string): boolean {
  const ns = permissions[namespace];
  if (ns === undefined) return true; // no restriction → allow all
  if (ns === '*') return true;
  const required = TICKET_TOOL_PERMISSIONS[toolName];
  return Array.isArray(ns) && (ns.includes(required) || ns.includes('*'));
}

// ─── Server builder ───────────────────────────────────────────────────────────

function buildMcpServer(registry: TicketRegistry, agentId: string, permissions: PermissionMap): McpServer {
  const server = new McpServer({ name: 'nano-agent-mcp-gateway', version: '1.0.0' });

  // tickets_list
  if (canCall(permissions, 'tickets', 'tickets_list')) {
    server.tool(
      'tickets_list',
      'List tickets with optional filters. Returns id, title, status, priority, assignee.',
      {
        status:   z.string().optional().describe('Abstract status: new|approved|in_progress|review|done|rejected|pending_input'),
        priority: z.string().optional().describe('Priority: CRITICAL|HIGH|MED|LOW'),
        assignee: z.string().optional().describe('Filter by assignee agent id'),
      },
      async ({ status, priority, assignee }) => {
        const tickets = await registry.listTickets({
          status:   status as AbstractStatus | undefined,
          priority: priority as TicketPriority | undefined,
          assignee,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(tickets, null, 2) }] };
      },
    );
  }

  // ticket_get
  if (canCall(permissions, 'tickets', 'ticket_get')) {
    server.tool(
      'ticket_get',
      'Get a single ticket with its comments.',
      { ticket_id: z.string().describe('Ticket ID (e.g. TICK-0001 or GH-42)') },
      async ({ ticket_id }) => {
        const ticket = await registry.getTicket(ticket_id);
        if (!ticket) return { content: [{ type: 'text' as const, text: `Ticket ${ticket_id} not found` }], isError: true };
        const comments = await registry.getComments(ticket_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ticket, comments }, null, 2) }] };
      },
    );
  }

  // ticket_create
  if (canCall(permissions, 'tickets', 'ticket_create')) {
    server.tool(
      'ticket_create',
      'Create a new ticket.',
      {
        title:    z.string().describe('Ticket title'),
        body:     z.string().optional().describe('Ticket description / tech spec'),
        priority: z.string().optional().describe('Priority: CRITICAL|HIGH|MED|LOW'),
        type:     z.string().optional().describe('Type: epic|story|task|bug|idea'),
      },
      async ({ title, body, priority, type }) => {
        const ticket = await registry.createTicket({
          title,
          body,
          priority: priority as TicketPriority | undefined,
          type:     type as TicketType | undefined,
          author:   agentId,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
      },
    );
  }

  // ticket_update
  if (canCall(permissions, 'tickets', 'ticket_update')) {
    server.tool(
      'ticket_update',
      'Update ticket fields (title, body, priority, assignee). Use ticket_approve or ticket_reject to change status.',
      {
        ticket_id: z.string().describe('Ticket ID'),
        title:     z.string().optional().describe('New title'),
        body:      z.string().optional().describe('New body / tech spec (replaces existing)'),
        priority:  z.string().optional().describe('New priority: CRITICAL|HIGH|MED|LOW'),
        assignee:  z.string().optional().describe('New assignee agent id'),
      },
      async ({ ticket_id, title, body, priority, assignee }) => {
        const ticket = await registry.updateTicket(ticket_id, {
          title,
          body,
          priority: priority as TicketPriority | undefined,
          assignee,
        }, agentId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
      },
    );
  }

  // ticket_approve — dedicated tool so ACL can allow approve separately from generic update
  if (canCall(permissions, 'tickets', 'ticket_approve')) {
    server.tool(
      'ticket_approve',
      'Approve a ticket. Transitions status to "approved" and triggers NATS pipeline event.',
      {
        ticket_id: z.string().describe('Ticket ID'),
        assignee:  z.string().optional().describe('Assign to this agent (e.g. "architect")'),
      },
      async ({ ticket_id, assignee }) => {
        const ticket = await registry.updateTicket(ticket_id, { status: 'approved', assignee }, agentId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
      },
    );
  }

  // ticket_reject
  if (canCall(permissions, 'tickets', 'ticket_reject')) {
    server.tool(
      'ticket_reject',
      'Reject a ticket. Transitions status to "rejected" and triggers NATS pipeline event.',
      { ticket_id: z.string().describe('Ticket ID') },
      async ({ ticket_id }) => {
        const ticket = await registry.updateTicket(ticket_id, { status: 'rejected' }, agentId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
      },
    );
  }

  // ticket_comment
  if (canCall(permissions, 'tickets', 'ticket_comment')) {
    server.tool(
      'ticket_comment',
      'Add a comment to a ticket.',
      {
        ticket_id: z.string().describe('Ticket ID'),
        body:      z.string().describe('Comment text'),
      },
      async ({ ticket_id, body }) => {
        const comment = await registry.addComment(ticket_id, body, agentId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(comment, null, 2) }] };
      },
    );
  }

  return server;
}

// ─── McpGateway ───────────────────────────────────────────────────────────────

export class McpGateway {
  private httpServer?: http.Server;

  constructor(
    private readonly registry: TicketRegistry,
    private readonly resolvePermissions: PermissionResolver,
  ) {}

  start(port: number): void {
    const app = express();
    app.use(express.json());

    // Stateless MCP endpoint — new server instance per request
    app.post('/mcp', async (req: Request, res: Response) => {
      const agentId = (req.headers['x-agent-id'] as string | undefined) ?? 'unknown';
      const permissions = this.resolvePermissions(agentId);

      logger.debug({ agentId, permissions }, 'MCP Gateway: request');

      try {
        const server = buildMcpServer(this.registry, agentId, permissions);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        res.on('close', () => {
          void transport.close();
          void server.close();
        });
      } catch (err) {
        logger.error({ err, agentId }, 'MCP Gateway: request failed');
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP Gateway internal error' });
        }
      }
    });

    // GET /mcp — return gateway info (useful for agent-runner config discovery)
    app.get('/mcp', (_req: Request, res: Response) => {
      res.json({
        name: 'nano-agent-mcp-gateway',
        version: '1.0.0',
        namespaces: ['tickets'],
      });
    });

    this.httpServer = app.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'MCP Gateway started');
    });
  }

  stop(): void {
    this.httpServer?.close();
  }
}
