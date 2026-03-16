/**
 * C1-C3 — NATS integration testy + SSE test
 *
 * C1: NATS konektivita
 * C2: Heartbeat od agentů (health.>)
 * C3: SSE event při vytvoření ticketu
 *
 * Předpoklad: aplikace běží na http://localhost:3001, NATS na localhost:4222
 */

import { connect, StringCodec } from 'nats';

const BASE = 'http://localhost:3001';
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';

describe('C1 — NATS konektivita', () => {
  test('připojí se k NATS serveru', async () => {
    const nc = await connect({ servers: NATS_URL });
    expect(nc.isClosed()).toBe(false);
    await nc.close();
  });

  test('publish/subscribe round-trip', async () => {
    const nc = await connect({ servers: NATS_URL });
    const sc = StringCodec();
    const subject = `test.ping.${Date.now()}`;

    const sub = nc.subscribe(subject, { max: 1 });
    nc.publish(subject, sc.encode('hello'));

    const msgs: string[] = [];
    for await (const msg of sub) {
      msgs.push(sc.decode(msg.data));
    }

    expect(msgs).toEqual(['hello']);
    await nc.close();
  });
});

describe('C2 — Heartbeat od agentů', () => {
  test('přijme heartbeat od alespoň jednoho agenta do 60s', async () => {
    const nc = await connect({ servers: NATS_URL });
    const sc = StringCodec();

    const received = await new Promise<boolean>((resolve) => {
      const sub = nc.subscribe('health.>', { max: 1 });

      const timer = setTimeout(() => {
        sub.unsubscribe();
        resolve(false);
      }, 60_000);

      void (async () => {
        for await (const msg of sub) {
          clearTimeout(timer);
          const payload = JSON.parse(sc.decode(msg.data)) as Record<string, unknown>;
          expect(typeof payload.agentId).toBe('string');
          expect(typeof payload.ts).toBe('number');
          resolve(true);
          break;
        }
      })();
    });

    await nc.close();
    expect(received).toBe(true);
  }, 65_000);
});

describe('C3 — SSE event při vytvoření ticketu', () => {
  test('přijme ticket_created SSE event po POST /api/tickets', async () => {
    const eventReceived = new Promise<Record<string, unknown>>((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error('SSE timeout — ticket_created event nedorazil do 10s'));
      }, 10_000);

      void fetch(`${BASE}/api/events`, { signal: controller.signal })
        .then(async (res) => {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            let event = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                event = line.slice(7).trim();
              } else if (line.startsWith('data: ') && event === 'ticket_created') {
                clearTimeout(timer);
                resolve(JSON.parse(line.slice(6)) as Record<string, unknown>);
                return;
              }
            }
          }
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== 'AbortError') reject(err);
        });
    });

    // Krátká pauza aby SSE spojení bylo navázáno
    await new Promise(r => setTimeout(r, 300));

    await fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'SSE test ticket C3' }),
    });

    const event = await eventReceived;
    expect((event as { ticket?: { title?: string } }).ticket?.title).toBe('SSE test ticket C3');
  }, 15_000);
});
