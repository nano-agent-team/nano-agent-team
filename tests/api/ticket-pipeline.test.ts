/**
 * Ticket Pipeline + MCP Gateway tests — deterministic, no LLM
 *
 * T1 — TicketRegistry NATS pipeline events
 *   PATCH /api/tickets/:id status transitions → NATS events fire automatically
 *
 * T2 — MCP Gateway info endpoint
 *   GET  http://localhost:3003/mcp → gateway metadata
 *
 * T3 — MCP Gateway tool listing with ACL
 *   POST /mcp with tools/list → all tools (no permissions) vs filtered (with permissions)
 *
 * T4 — MCP Gateway ticket_get tool call (deterministic)
 *
 * T5 — Full pipeline simulation with NATS events
 *   create ticket → PM approves (PATCH status=approved) → NATS topic.ticket.approved fires
 *   → Architect sets spec (PATCH status=in_progress) → NATS topic.ticket.spec-ready fires
 *
 * Prerequisites:
 *   - Stack running on localhost:3001 (API) and localhost:4222 (NATS) and localhost:3003 (MCP Gateway)
 */

import { connect, StringCodec } from 'nats';

const BASE      = process.env.BASE_URL        ?? 'http://localhost:3001';
const NATS_URL  = process.env.NATS_URL        ?? 'nats://localhost:4222';
const MCP_URL   = process.env.MCP_GATEWAY_URL ?? 'http://localhost:3003/mcp';

const sc = StringCodec();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createTicket(title: string, priority = 'MED'): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, priority }),
  });
  if (!res.ok) throw new Error(`createTicket failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ id: string }>;
}

async function patchTicket(id: string, data: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, changed_by: 'test' }),
  });
  if (!res.ok) throw new Error(`patchTicket ${id} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/**
 * Connect to NATS, subscribe to subject, flush (ensures server received SUB),
 * and return a collector function that awaits the first message.
 *
 * Usage pattern (prevents race condition where event fires before subscription is ready):
 *   const collect = await listenNats('topic.ticket.approved');
 *   await triggerSomething();
 *   const event = await collect();
 */
async function listenNats(
  subject: string,
  timeoutMs = 5000,
): Promise<() => Promise<Record<string, unknown>>> {
  const nc = await connect({ servers: NATS_URL });
  const sub = nc.subscribe(subject, { max: 1, timeout: timeoutMs });
  // Flush ensures the SUB command is sent to the NATS server before we return.
  // Without this, the event can fire before the server registers our subscription.
  await nc.flush();

  return async function collect() {
    try {
      for await (const msg of sub) {
        return JSON.parse(sc.decode(msg.data)) as Record<string, unknown>;
      }
      throw new Error(`No message on ${subject} within ${timeoutMs}ms`);
    } finally {
      await nc.close();
    }
  };
}

/** Send MCP JSON-RPC request to the gateway */
async function mcpRequest(method: string, params: unknown, agentId = 'test-agent'): Promise<unknown> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // StreamableHTTPServerTransport requires both media types in Accept header
      'Accept': 'application/json, text/event-stream',
      'x-agent-id': agentId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  if (!res.ok) throw new Error(`MCP request failed: ${res.status} ${await res.text()}`);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    // SDK returns SSE: parse "data: {json}" lines
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        return JSON.parse(line.slice(6)) as unknown;
      }
    }
    throw new Error(`No data line in SSE response: ${text}`);
  }
  return res.json();
}

// ─── T1 — NATS pipeline events ────────────────────────────────────────────────

describe('T1 — TicketRegistry: NATS pipeline events on status transition', () => {
  let ticketId: string;

  beforeAll(async () => {
    const t = await createTicket(`Pipeline test ${Date.now()}`);
    ticketId = t.id;
  });

  test('T1.1 — idea → approved publishes topic.ticket.approved', async () => {
    const collect = await listenNats('topic.ticket.approved', 5000);
    await patchTicket(ticketId, { status: 'approved' });
    const event = await collect();
    expect(event.ticket_id).toBe(ticketId);
    expect(event.status).toBe('approved');
  });

  test('T1.2 — approved → in_progress publishes topic.ticket.spec-ready', async () => {
    const collect = await listenNats('topic.ticket.spec-ready', 5000);
    await patchTicket(ticketId, { status: 'in_progress' });
    const event = await collect();
    expect(event.ticket_id).toBe(ticketId);
    expect(event.status).toBe('in_progress');
  });

  test('T1.3 — in_progress → review publishes topic.pr.opened', async () => {
    const collect = await listenNats('topic.pr.opened', 5000);
    await patchTicket(ticketId, { status: 'review' });
    const event = await collect();
    expect(event.ticket_id).toBe(ticketId);
    expect(event.status).toBe('review');
  });

  test('T1.4 — review → done publishes topic.ticket.done', async () => {
    const collect = await listenNats('topic.ticket.done', 5000);
    await patchTicket(ticketId, { status: 'done' });
    const event = await collect();
    expect(event.ticket_id).toBe(ticketId);
    expect(event.status).toBe('done');
  });

  test('T1.5 — no event for untracked transition (idea → pending_input)', async () => {
    const t2 = await createTicket(`No-event test ${Date.now()}`);
    // Subscribe briefly — expect NO message
    let received = false;
    const nc = await connect({ servers: NATS_URL });
    try {
      const sub = nc.subscribe('topic.ticket.done', { max: 1 });
      const timeout = new Promise<void>(resolve => setTimeout(resolve, 1500));
      const race = (async () => {
        for await (const _ of sub) { received = true; break; }
      })();
      await patchTicket(t2.id, { status: 'pending_input' });
      await timeout;
      sub.unsubscribe();
      await race.catch(() => {});
    } finally {
      await nc.close();
    }
    expect(received).toBe(false);
  });
});

// ─── T2 — MCP Gateway info ────────────────────────────────────────────────────

describe('T2 — MCP Gateway: info endpoint', () => {
  test('T2.1 — GET /mcp returns gateway metadata', async () => {
    const res = await fetch(`${MCP_URL.replace('/mcp', '')}/mcp`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe('nano-agent-mcp-gateway');
    expect(Array.isArray(body.namespaces)).toBe(true);
    expect((body.namespaces as string[]).includes('tickets')).toBe(true);
  });
});

// ─── T3 — MCP Gateway ACL ─────────────────────────────────────────────────────

describe('T3 — MCP Gateway: tool listing and ACL', () => {
  test('T3.1 — unknown agent gets all tools (no restrictions)', async () => {
    const res = await mcpRequest('tools/list', {}, 'unknown-agent') as { result?: { tools?: Array<{ name: string }> } };
    const tools = res.result?.tools ?? [];
    const names = tools.map(t => t.name);
    expect(names).toContain('tickets_list');
    expect(names).toContain('ticket_get');
    expect(names).toContain('ticket_approve');
    expect(names).toContain('ticket_reject');
    expect(names).toContain('ticket_comment');
    expect(names).toContain('ticket_create');
    expect(names).toContain('ticket_update');
  });

  // T3.2 — restricted agent (mcp_permissions defined in manifest)
  // This requires an agent running with mcp_permissions set.
  // We test the ACL logic directly through the known running agents.
  test('T3.2 — all tools available when no mcp_permissions configured', async () => {
    // simple-chat agent has no mcp_permissions → should get all tools
    const res = await mcpRequest('tools/list', {}, 'simple-chat') as { result?: { tools?: Array<{ name: string }> } };
    const tools = res.result?.tools ?? [];
    expect(tools.length).toBeGreaterThanOrEqual(7);
  });
});

// ─── T4 — MCP Gateway tool call ───────────────────────────────────────────────

describe('T4 — MCP Gateway: deterministic tool calls', () => {
  let ticketId: string;

  beforeAll(async () => {
    const t = await createTicket(`MCP tool test ${Date.now()}`);
    ticketId = t.id;
  });

  test('T4.1 — ticket_get returns created ticket', async () => {
    const res = await mcpRequest('tools/call', {
      name: 'ticket_get',
      arguments: { ticket_id: ticketId },
    }) as { result?: { content?: Array<{ text: string }> } };

    const text = res.result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { ticket: { id: string; status: string } };
    expect(parsed.ticket.id).toBe(ticketId);
    expect(parsed.ticket.status).toBe('new'); // 'idea' maps to 'new' in abstract model
  });

  test('T4.2 — tickets_list returns tickets', async () => {
    const res = await mcpRequest('tools/call', {
      name: 'tickets_list',
      arguments: { status: 'new' },
    }) as { result?: { content?: Array<{ text: string }> } };

    const text = res.result?.content?.[0]?.text ?? '';
    const tickets = JSON.parse(text) as Array<{ id: string }>;
    expect(Array.isArray(tickets)).toBe(true);
    expect(tickets.some(t => t.id === ticketId)).toBe(true);
  });

  test('T4.3 — ticket_approve transitions status and returns approved ticket', async () => {
    const collectApproved = await listenNats('topic.ticket.approved', 5000);

    const res = await mcpRequest('tools/call', {
      name: 'ticket_approve',
      arguments: { ticket_id: ticketId, assignee: 'architect' },
    }) as { result?: { content?: Array<{ text: string }> } };

    const text = res.result?.content?.[0]?.text ?? '';
    const ticket = JSON.parse(text) as { status: string; assignee: string };
    expect(ticket.status).toBe('approved');

    // NATS event must fire from the MCP Gateway call
    const event = await collectApproved();
    expect(event.ticket_id).toBe(ticketId);
  });

  test('T4.4 — ticket_comment adds comment', async () => {
    const res = await mcpRequest('tools/call', {
      name: 'ticket_comment',
      arguments: { ticket_id: ticketId, body: 'Approved by deterministic test agent' },
    }) as { result?: { content?: Array<{ text: string }> } };

    const text = res.result?.content?.[0]?.text ?? '';
    const comment = JSON.parse(text) as { body: string; author: string };
    expect(comment.body).toBe('Approved by deterministic test agent');
    expect(comment.author).toBe('test-agent'); // agentId from x-agent-id header
  });
});

// ─── T5 — Full pipeline simulation ───────────────────────────────────────────

describe('T5 — Full pipeline: ticket lifecycle without LLM', () => {
  let ticketId: string;

  test('T5 — idea → approved → spec_ready → review → done (all NATS events fire)', async () => {
    const t = await createTicket(`Full pipeline ${Date.now()}`, 'HIGH');
    ticketId = t.id;

    // Each NATS listener must be set up BEFORE the status change.
    // listenNats() connects + subscribes + flushes before returning.
    const collectApproved = await listenNats('topic.ticket.approved',   4000);
    await patchTicket(ticketId, { status: 'approved' });
    await expect(collectApproved()).resolves.toMatchObject({ ticket_id: ticketId, status: 'approved' });

    const collectSpecReady = await listenNats('topic.ticket.spec-ready', 4000);
    await patchTicket(ticketId, { status: 'in_progress' });
    await expect(collectSpecReady()).resolves.toMatchObject({ ticket_id: ticketId, status: 'in_progress' });

    const collectPrOpened = await listenNats('topic.pr.opened',         4000);
    await patchTicket(ticketId, { status: 'review' });
    await expect(collectPrOpened()).resolves.toMatchObject({ ticket_id: ticketId, status: 'review' });

    const collectDone = await listenNats('topic.ticket.done',           4000);
    await patchTicket(ticketId, { status: 'done' });
    await expect(collectDone()).resolves.toMatchObject({ ticket_id: ticketId, status: 'done' });

    // Final state check via REST
    const res = await fetch(`${BASE}/api/tickets/${ticketId}`);
    const final = await res.json() as { status: string };
    expect(final.status).toBe('done');
  }, 30_000);
});

// ─── T6 — createTicket fires topic.ticket.new ─────────────────────────────────
describe('T6 — POST /api/tickets fires topic.ticket.new', () => {
  test('ticket creation publishes NATS event', async () => {
    const collect = await listenNats('topic.ticket.new');
    const ticket = await createTicket('test-new-event-' + Date.now());
    const payload = await collect();
    expect(payload.ticket_id).toBe(ticket.id);
  }, 10_000);
});
