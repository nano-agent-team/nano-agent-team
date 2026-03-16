/**
 * B1-B5 — Ticket CRUD REST API testy
 * Předpoklad: aplikace běží na http://localhost:3001
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';

describe('B1 — POST /api/tickets (vytvoření)', () => {
  let ticketId: string;

  test('vytvoří ticket a vrátí 201', async () => {
    const res = await fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test ticket B1', priority: 'HIGH' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toMatch(/^TICK-\d{4}$/);
    expect(body.title).toBe('Test ticket B1');
    expect(body.status).toBe('idea');
    expect(body.priority).toBe('HIGH');
    expect(body.created_at).toBeDefined();
    ticketId = body.id as string;
  });

  test('vrátí 400 bez title', async () => {
    const res = await fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'HIGH' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('B2 — GET /api/tickets/:id (načtení)', () => {
  let ticketId: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test ticket B2' }),
    });
    const body = await res.json() as { id: string };
    ticketId = body.id;
  });

  test('vrátí ticket podle id', async () => {
    const res = await fetch(`${BASE}/api/tickets/${ticketId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; title: string };
    expect(body.id).toBe(ticketId);
    expect(body.title).toBe('Test ticket B2');
  });

  test('vrátí 404 pro neexistující id', async () => {
    const res = await fetch(`${BASE}/api/tickets/TICK-9999`);
    expect(res.status).toBe(404);
  });
});

describe('B3 — PATCH /api/tickets/:id (update statusu)', () => {
  let ticketId: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test ticket B3' }),
    });
    const body = await res.json() as { id: string };
    ticketId = body.id;
  });

  test('změní status na approved', async () => {
    const res = await fetch(`${BASE}/api/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', changed_by: 'test' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('approved');
  });

  test('vrátí 400 pro neplatný status', async () => {
    const res = await fetch(`${BASE}/api/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'invalid_status' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('B4 — GET /api/tickets (seznam s filtrem)', () => {
  beforeAll(async () => {
    // Vytvoř ticket se statusem approved
    await fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Filtered ticket B4', status: 'approved' }),
    });
  });

  test('filtruje podle statusu', async () => {
    const res = await fetch(`${BASE}/api/tickets?status=approved`);
    expect(res.status).toBe(200);
    const tickets = await res.json() as Array<{ status: string }>;
    expect(tickets.length).toBeGreaterThan(0);
    for (const t of tickets) {
      expect(t.status).toBe('approved');
    }
  });

  test('vrátí všechny tickety bez filtru', async () => {
    const res = await fetch(`${BASE}/api/tickets`);
    expect(res.status).toBe(200);
    const tickets = await res.json() as unknown[];
    expect(Array.isArray(tickets)).toBe(true);
  });
});

describe('B5 — POST /api/tickets/:id/comments', () => {
  let ticketId: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test ticket B5' }),
    });
    const body = await res.json() as { id: string };
    ticketId = body.id;
  });

  test('přidá komentář', async () => {
    const res = await fetch(`${BASE}/api/tickets/${ticketId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'tester', body: 'Testovací komentář' }),
    });
    expect(res.status).toBe(201);
    const comment = await res.json() as { author: string; body: string };
    expect(comment.author).toBe('tester');
    expect(comment.body).toBe('Testovací komentář');
  });

  test('načte komentáře', async () => {
    const res = await fetch(`${BASE}/api/tickets/${ticketId}/comments`);
    expect(res.status).toBe(200);
    const comments = await res.json() as unknown[];
    expect(comments.length).toBeGreaterThan(0);
  });

  test('vrátí 400 bez autora nebo body', async () => {
    const res = await fetch(`${BASE}/api/tickets/${ticketId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'tester' }), // chybí body
    });
    expect(res.status).toBe(400);
  });
});
