/**
 * Multi-instance agent dispatch test suite
 *
 * Unit tests (T1-T5): pure logic, no stack / Docker needed
 * Integration tests (T6-T11): require live stack + test agent containers
 *
 * Run:  npm run test:api -- multi-instance
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { expandInstances } from '../../src/workflow-registry.js';
import { getInstanceId, resolveTopicsForAgent } from '../../src/agent-registry.js';
import type { WorkflowManifest, LoadedAgent, AgentManifest } from '../../src/agent-registry.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001';
const NATS_URL  = process.env.NATS_URL  ?? 'nats://localhost:4222';

// CI environments are slower — scale timeouts accordingly
const CI_MULT = process.env.CI ? 3 : 1;

const __dirname        = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT     = path.resolve(__dirname, '..', '..');
const DATA_DIR         = path.join(PROJECT_ROOT, 'data');
const FIXTURE_TEAM_DIR = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'test-team');
const FIXTURE_AGENT_DIR= path.join(PROJECT_ROOT, 'tests', 'fixtures', 'test-agent');
const INSTALLED_TEAM   = path.join(DATA_DIR, 'teams', 'test-dispatch-team');

const TEST_INSTANCES = ['worker-a', 'worker-b', 'pool-worker-1', 'pool-worker-2'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntil(
  fn: () => Promise<boolean>,
  { timeoutMs, intervalMs, label }: { timeoutMs: number; intervalMs: number; label: string },
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`);
}

// ─── Module-level integration setup/teardown ──────────────────────────────────

let stackAvailable = false;

beforeAll(async () => {
  // 1. Check stack reachability
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    stackAvailable = true;
  } catch {
    console.warn('[multi-instance] Stack not reachable — integration tests will be skipped');
    return;
  }

  // 2. Build nano-test-agent:latest on host, then load into nate's DinD
  console.log('[multi-instance] Building nano-test-agent:latest on host...');
  execFileSync('docker', ['build', '-t', 'nano-test-agent:latest', FIXTURE_AGENT_DIR], {
    stdio: 'inherit',
    timeout: 120_000 * CI_MULT,
  });
  console.log('[multi-instance] Loading nano-test-agent:latest into nate DinD...');
  execSync('docker save nano-test-agent:latest | docker exec -i nate docker load', {
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 60_000 * CI_MULT,
  });

  // 3. Install test team
  fs.mkdirSync(INSTALLED_TEAM, { recursive: true });
  execSync(`cp -r ${FIXTURE_TEAM_DIR}/. ${INSTALLED_TEAM}/`);

  const configPath = path.join(DATA_DIR, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    installed?: { teams?: string[] };
  };
  config.installed ??= {};
  config.installed.teams ??= [];
  if (!config.installed.teams.includes('test-dispatch-team')) {
    config.installed.teams.push('test-dispatch-team');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  // 4. Wait for volume sync
  await pollUntil(
    async () => {
      try {
        execSync('docker exec nate test -f /data/teams/test-dispatch-team/agents/worker/manifest.json', { stdio: 'ignore' });
        return true;
      } catch { return false; }
    },
    { timeoutMs: 10_000 * CI_MULT, intervalMs: 200, label: 'test team files synced to container' },
  );

  // 5. Reload
  await fetch(`${BASE_URL}/internal/reload`, { method: 'POST' });

  // 6. Wait for all 4 instances running
  console.log('[multi-instance] Waiting for 4 test instances to start...');
  await pollUntil(
    async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/health`);
        if (!res.ok) return false;
        const { agents } = await res.json() as { agents: Array<{ agentId: string; status: string }> };
        const running = new Set(agents.filter(a => a.status === 'running').map(a => a.agentId));
        return TEST_INSTANCES.every(id => running.has(id));
      } catch { return false; }
    },
    { timeoutMs: 120_000 * CI_MULT, intervalMs: 3_000, label: 'all 4 instances running' },
  );

  // 7. Wait for heartbeats from worker-a and worker-b
  console.log('[multi-instance] Waiting for heartbeats from worker-a and worker-b...');
  await pollUntil(
    async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/health`);
        const { agents } = await res.json() as { agents: Array<{ agentId: string; lastHeartbeat?: string }> };
        return (
          agents.some(a => a.agentId === 'worker-a' && !!a.lastHeartbeat) &&
          agents.some(a => a.agentId === 'worker-b' && !!a.lastHeartbeat)
        );
      } catch { return false; }
    },
    { timeoutMs: 30_000 * CI_MULT, intervalMs: 2_000, label: 'heartbeats from worker-a and worker-b' },
  );

  console.log('[multi-instance] Setup complete — integration tests ready');
}, 180_000 * CI_MULT);

afterAll(async () => {
  if (!stackAvailable) return;

  if (fs.existsSync(INSTALLED_TEAM)) fs.rmSync(INSTALLED_TEAM, { recursive: true, force: true });

  const configPath = path.join(DATA_DIR, 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { installed?: { teams?: string[] } };
    if (config.installed?.teams) {
      config.installed.teams = config.installed.teams.filter(t => t !== 'test-dispatch-team');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } catch { /* ignore */ }

  for (const name of TEST_INSTANCES.map(id => `nano-agent-${id}`)) {
    try {
      execSync(`docker exec nate docker stop ${name} 2>/dev/null; docker exec nate docker rm ${name} 2>/dev/null`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  }

  await fetch(`${BASE_URL}/internal/reload`, { method: 'POST' }).catch(() => {});
}, 60_000 * CI_MULT);

// ─── NATS helpers ─────────────────────────────────────────────────────────────

async function publishToNats(subject: string, payload: string): Promise<void> {
  const { connect, StringCodec } = await import('nats');
  const sc = StringCodec();
  const nc = await connect({ servers: NATS_URL, timeout: 3000 });
  const js = nc.jetstream();
  await js.publish(subject, sc.encode(payload));
  await nc.drain();
}

async function collectReceived(
  count: number,
  timeoutMs: number,
): Promise<Array<{ instanceId: string; subject: string; data: string }>> {
  const { connect, StringCodec } = await import('nats');
  const sc = StringCodec();
  const nc = await connect({ servers: NATS_URL, timeout: 3000 });
  const results: Array<{ instanceId: string; subject: string; data: string }> = [];

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      await nc.drain().catch(() => {});
      resolve(results);
    }, timeoutMs);

    const sub = nc.subscribe('test.received');
    void (async () => {
      for await (const msg of sub) {
        try {
          const r = JSON.parse(sc.decode(msg.data)) as { instanceId: string; subject: string; data: string };
          results.push(r);
          if (results.length >= count) {
            clearTimeout(timer);
            await nc.drain().catch(() => {});
            resolve(results);
            return;
          }
        } catch { /* malformed */ }
      }
    })();
  });
}

async function natsAvailable(): Promise<boolean> {
  const { connect } = await import('nats');
  return connect({ servers: NATS_URL, timeout: 2000 })
    .then(nc => nc.drain().then(() => true))
    .catch(() => false);
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIT TESTS — no stack / Docker needed
// ═════════════════════════════════════════════════════════════════════════════

describe('T1: expandInstances — named instances', () => {
  const workflow: WorkflowManifest = {
    id: 'test-named', name: 'Test Named', version: '0.1.0',
    agents: ['worker'],
    instances: { a: { manifest: 'worker' }, b: { manifest: 'worker' } },
  };
  const agentsDir = path.join(FIXTURE_TEAM_DIR, 'agents');

  test('produces 2 LoadedAgents', () => {
    expect(expandInstances(workflow, agentsDir)).toHaveLength(2);
  });

  test('instanceIds are "a" and "b"', () => {
    const ids = expandInstances(workflow, agentsDir).map(a => a.instanceId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  test('consumerName equals instanceId for named instances', () => {
    for (const agent of expandInstances(workflow, agentsDir)) {
      expect(agent.consumerName).toBe(agent.instanceId);
    }
  });
});

describe('T2: expandInstances — competing pool count: 2', () => {
  const workflow: WorkflowManifest = {
    id: 'test-pool', name: 'Test Pool', version: '0.1.0',
    agents: ['worker'],
    instances: { pool: { manifest: 'worker', count: 2 } },
  };
  const agentsDir = path.join(FIXTURE_TEAM_DIR, 'agents');

  test('produces 2 LoadedAgents', () => {
    expect(expandInstances(workflow, agentsDir)).toHaveLength(2);
  });

  test('instanceIds are "pool-1" and "pool-2"', () => {
    const ids = expandInstances(workflow, agentsDir).map(a => a.instanceId);
    expect(ids).toContain('pool-1');
    expect(ids).toContain('pool-2');
  });

  test('consumerName is manifest.id ("worker") — shared consumer for all pool members', () => {
    for (const agent of expandInstances(workflow, agentsDir)) {
      expect(agent.consumerName).toBe('worker');
    }
  });
});

describe('T3: expandInstances — broadcast injects subject into binding inputs', () => {
  const workflow: WorkflowManifest = {
    id: 'test-broadcast', name: 'Test Broadcast', version: '0.1.0',
    agents: ['worker'],
    instances: { a: { manifest: 'worker' }, b: { manifest: 'worker' } },
    dispatch: { 'topic.broadcast': { strategy: 'broadcast', to: ['a', 'b'] } },
  };
  const agentsDir = path.join(FIXTURE_TEAM_DIR, 'agents');

  test('both instances have "topic.broadcast" in their binding input values', () => {
    const result = expandInstances(workflow, agentsDir);
    expect(result).toHaveLength(2);
    for (const agent of result) {
      expect(Object.values(agent.binding?.inputs ?? {})).toContain('topic.broadcast');
    }
  });
});

describe('T4: expandInstances — fallback when no instances block', () => {
  const workflow: WorkflowManifest = {
    id: 'test-fallback', name: 'Test Fallback', version: '0.1.0',
    agents: ['worker'],
  };
  const agentsDir = path.join(FIXTURE_TEAM_DIR, 'agents');

  test('produces 1 LoadedAgent with instanceId = manifest.id', () => {
    const result = expandInstances(workflow, agentsDir);
    expect(result).toHaveLength(1);
    expect(result[0].instanceId).toBe('worker');
  });
});

describe('T5: getInstanceId', () => {
  test('returns instanceId when set', () => {
    const agent: LoadedAgent = { manifest: { id: 'worker', name: 'W', version: '0.1.0' }, dir: '/tmp', instanceId: 'worker-a' };
    expect(getInstanceId(agent)).toBe('worker-a');
  });

  test('falls back to manifest.id when instanceId is absent', () => {
    const agent: LoadedAgent = { manifest: { id: 'worker', name: 'W', version: '0.1.0' }, dir: '/tmp' };
    expect(getInstanceId(agent)).toBe('worker');
  });
});

describe('T6: resolveTopicsForAgent — entrypoint { from, to } binding', () => {
  const manifest: AgentManifest = { id: 'worker', name: 'W', version: '0.1.0', entrypoints: ['inbox', 'tickets'] };

  test('{ from, to } adds agent.{instanceId}.{portName} to consumer filter (not the from subject)', () => {
    const topics = resolveTopicsForAgent(
      manifest,
      { inputs: { t: { from: 'topic.external', to: 'tickets' } } },
      'worker-a',
    );
    expect(topics).toContain('agent.worker-a.tickets');
    expect(topics).not.toContain('topic.external');
  });

  test('inbox is always included alongside entrypoint subjects', () => {
    const topics = resolveTopicsForAgent(
      manifest,
      { inputs: { t: { from: 'topic.external', to: 'tickets' } } },
      'worker-a',
    );
    expect(topics).toContain('agent.worker-a.inbox');
    expect(topics).toContain('agent.worker-a.tickets');
  });

  test('mixed binding: plain string + { from, to } both work', () => {
    const topics = resolveTopicsForAgent(
      manifest,
      { inputs: { direct: 'topic.direct', ep: { from: 'topic.ext', to: 'tickets' } } },
      'worker-a',
    );
    expect(topics).toContain('topic.direct');
    expect(topics).toContain('agent.worker-a.tickets');
    expect(topics).not.toContain('topic.ext');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS — require live stack + test agent containers
// ═════════════════════════════════════════════════════════════════════════════

describe('T6: Named instances started correctly', () => {
  test('worker-a, worker-b, pool-worker-1, pool-worker-2 all running', async () => {
    if (!stackAvailable) { console.warn('T6 skipped — stack not available'); return; }

    const res = await fetch(`${BASE_URL}/api/health`);
    const { agents } = await res.json() as { agents: Array<{ agentId: string; status: string }> };
    const running = agents.filter(a => a.status === 'running').map(a => a.agentId);

    for (const id of TEST_INSTANCES) {
      expect(running, `expected ${id} to be running`).toContain(id);
    }
  }, 10_000 * CI_MULT);
});

describe('T7: Dispatch least-busy — routes to worker-a or worker-b', () => {
  test('message on topic.test.least-busy is received by worker-a or worker-b', async () => {
    if (!stackAvailable) { console.warn('T7 skipped'); return; }
    if (!(await natsAvailable())) { console.warn('T7 skipped — NATS not reachable'); return; }

    const payload = JSON.stringify({ text: 'least-busy-test', ts: Date.now() });
    const [received] = await Promise.all([
      collectReceived(1, 10_000 * CI_MULT),
      sleep(200).then(() => publishToNats('topic.test.least-busy', payload)),
    ]);

    expect(received).toHaveLength(1);
    expect(['worker-a', 'worker-b']).toContain(received[0].instanceId);
    expect(['pool-worker-1', 'pool-worker-2']).not.toContain(received[0].instanceId);
  }, 15_000 * CI_MULT);
});

describe('T8: Dispatch round-robin — alternates between instances', () => {
  test('4 messages to topic.test.round-robin are split between worker-a and worker-b', async () => {
    if (!stackAvailable) { console.warn('T8 skipped'); return; }
    if (!(await natsAvailable())) { console.warn('T8 skipped — NATS not reachable'); return; }

    const [received] = await Promise.all([
      collectReceived(4, 20_000 * CI_MULT),
      (async () => {
        for (let i = 0; i < 4; i++) {
          await publishToNats('topic.test.round-robin', JSON.stringify({ n: i, ts: Date.now() }));
          await sleep(150);
        }
      })(),
    ]);

    expect(received.length).toBeGreaterThanOrEqual(2);
    const countA = received.filter(r => r.instanceId === 'worker-a').length;
    const countB = received.filter(r => r.instanceId === 'worker-b').length;
    expect(countA).toBeGreaterThanOrEqual(1);
    expect(countB).toBeGreaterThanOrEqual(1);
  }, 25_000 * CI_MULT);
});

describe('T9: Dispatch broadcast — both instances receive', () => {
  test('one message on topic.test.broadcast is received by both worker-a AND worker-b', async () => {
    if (!stackAvailable) { console.warn('T9 skipped'); return; }
    if (!(await natsAvailable())) { console.warn('T9 skipped — NATS not reachable'); return; }

    const payload = JSON.stringify({ text: 'broadcast-test', ts: Date.now() });
    const [received] = await Promise.all([
      collectReceived(2, 15_000 * CI_MULT),
      sleep(200).then(() => publishToNats('topic.test.broadcast', payload)),
    ]);

    expect(received.length).toBeGreaterThanOrEqual(2);
    const ids = received.map(r => r.instanceId);
    expect(ids).toContain('worker-a');
    expect(ids).toContain('worker-b');
  }, 20_000 * CI_MULT);
});

describe('T10: Direct binding — worker-a gets topic.test.direct-a', () => {
  test('message on topic.test.direct-a is received only by worker-a', async () => {
    if (!stackAvailable) { console.warn('T10 skipped'); return; }
    if (!(await natsAvailable())) { console.warn('T10 skipped — NATS not reachable'); return; }

    const payload = JSON.stringify({ text: 'direct-a-test', ts: Date.now() });
    const [received] = await Promise.all([
      collectReceived(1, 10_000 * CI_MULT),
      sleep(200).then(() => publishToNats('topic.test.direct-a', payload)),
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].instanceId).toBe('worker-a');
  }, 15_000 * CI_MULT);
});

describe('T11: Competing pool — messages distributed across pool-worker-1 and pool-worker-2', () => {
  test('4 messages to topic.test.pool are processed by pool worker instances', async () => {
    if (!stackAvailable) { console.warn('T11 skipped'); return; }
    if (!(await natsAvailable())) { console.warn('T11 skipped — NATS not reachable'); return; }

    const [received] = await Promise.all([
      collectReceived(4, 20_000 * CI_MULT),
      (async () => {
        for (let i = 0; i < 4; i++) {
          await publishToNats('topic.test.pool', JSON.stringify({ n: i, ts: Date.now() }));
          await sleep(150);
        }
      })(),
    ]);

    expect(received.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(received.map(r => r.instanceId));
    expect(['pool-worker-1', 'pool-worker-2'].some(id => ids.has(id))).toBe(true);
    for (const r of received) {
      expect(['pool-worker-1', 'pool-worker-2']).toContain(r.instanceId);
    }
  }, 25_000 * CI_MULT);
});

describe('T12: Entrypoint route — { from, to } binding routes to agent.{id}.{portName}', () => {
  test('message on topic.test.entrypoint-a is received by worker-a on its .tickets entrypoint', async () => {
    if (!stackAvailable) { console.warn('T12 skipped'); return; }
    if (!(await natsAvailable())) { console.warn('T12 skipped — NATS not reachable'); return; }

    const payload = JSON.stringify({ text: 'entrypoint-test', ts: Date.now() });
    const [received] = await Promise.all([
      collectReceived(1, 10_000 * CI_MULT),
      sleep(200).then(() => publishToNats('topic.test.entrypoint-a', payload)),
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].instanceId).toBe('worker-a');
    expect(received[0].subject).toBe('agent.worker-a.tickets');
  }, 15_000 * CI_MULT);
});
