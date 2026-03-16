/**
 * A1-A4 — API smoke testy
 * Předpoklad: aplikace běží na http://localhost:3001
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';

describe('A1 — GET /api/health', () => {
  let body: Record<string, unknown>;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    body = await res.json() as Record<string, unknown>;
  });

  test('status je ok', () => {
    expect(body.status).toBe('ok');
  });

  test('setupMode je ready', () => {
    expect(body.setupMode).toBe('ready');
  });

  test('agents pole existuje', () => {
    const agents = body.agents as Array<{ status: string; agentId: string }>;
    // V CI agenti startují bez reálných credentials — stačí že pole existuje
    expect(Array.isArray(agents)).toBe(true);
  });

  test('ts je čerstvé (< 5s)', () => {
    const ts = body.ts as number;
    expect(Date.now() - ts).toBeLessThan(5000);
  });
});

describe('A2 — GET /api/plugins', () => {
  let plugins: Array<{ id: string }>;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/plugins`);
    expect(res.status).toBe(200);
    plugins = await res.json() as Array<{ id: string }>;
  });

  test('vrátí pole pluginů', () => {
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThan(0);
  });

  test('obsahuje settings plugin', () => {
    expect(plugins.some(p => p.id === 'settings')).toBe(true);
  });

  test('obsahuje simple-chat plugin', () => {
    expect(plugins.some(p => p.id === 'simple-chat')).toBe(true);
  });
});

describe('A3 — GET /api/config', () => {
  test('vrátí HTTP 200 s configem', async () => {
    const res = await fetch(`${BASE}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });
});

describe('A4 — GET /api/config/status', () => {
  test('setup je complete', async () => {
    const res = await fetch(`${BASE}/api/config/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { complete: boolean; missing: string[] };
    expect(body.complete).toBe(true);
    expect(body.missing).toHaveLength(0);
  });
});
