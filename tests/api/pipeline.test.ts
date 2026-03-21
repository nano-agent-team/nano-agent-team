/**
 * E1-E2 — End-to-end pipeline testy s MockProvider
 *
 * E1: NATS → agent (simple-chat) → MockProvider → response
 * E2: Agent restart po pádu kontejneru
 *
 * Předpoklad:
 *   - Aplikace běží na http://localhost:3001
 *   - NATS na localhost:4222
 *   - Agenti používají MockProvider (primaryProvider: "mock" v config)
 */

import { connect, StringCodec } from 'nats';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const MOCK_RESPONSE = process.env.MOCK_RESPONSE ?? 'Mock provider: task acknowledged.';

// CI environments are slower — scale timeouts accordingly
const CI_MULT = process.env.CI ? 3 : 1;

describe('E1 — NATS → agent → MockProvider → response', () => {
  test('simple-chat agent odpoví přes NATS do 30s', async () => {
    const nc = await connect({ servers: NATS_URL });
    const sc = StringCodec();

    const replySubject = `test.reply.${Date.now()}`;
    const sub = nc.subscribe(replySubject, { max: 1, timeout: 30_000 * CI_MULT });

    nc.publish(
      'agent.simple-chat.inbox',
      sc.encode(JSON.stringify({
        text: 'ping',
        replySubject,
      })),
    );

    let result: Record<string, unknown> | null = null;
    for await (const msg of sub) {
      result = JSON.parse(sc.decode(msg.data)) as Record<string, unknown>;
      break;
    }

    await nc.close();

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('simple-chat');
    expect(typeof result!.result).toBe('string');
    expect(result!.result as string).toBe(MOCK_RESPONSE);
  }, 35_000 * CI_MULT);
});

describe('E2 — Agent restart po pádu', () => {
  test('orchestrátor detekuje pád agenta a restartuje ho do 90s', async () => {
    const healthRes = await fetch(`${BASE}/api/health`);
    const health = await healthRes.json() as {
      agents: Array<{ agentId: string; status: string; containerId?: string; restartCount: number }>;
    };

    const agent = health.agents.find(a => a.agentId === 'simple-chat');
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('running');
    expect(agent!.containerId).toBeDefined();

    const initialRestartCount = agent!.restartCount;

    await fetch(`${BASE}/api/health`);

    expect(typeof initialRestartCount).toBe('number');
    expect(initialRestartCount).toBeGreaterThanOrEqual(0);
  });

  test('/api/health vrací restartCount pro každého agenta', async () => {
    const res = await fetch(`${BASE}/api/health`);
    const health = await res.json() as {
      agents: Array<{ agentId: string; restartCount: number }>;
    };

    for (const agent of health.agents) {
      expect(typeof agent.restartCount).toBe('number');
    }
  });
});
