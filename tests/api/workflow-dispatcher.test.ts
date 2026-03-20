/**
 * WorkflowDispatcher — loop cancellation unit tests
 *
 * Tests T1-T3: pure logic, no NATS stack / Docker needed.
 * Uses mock objects for NatsConnection, JetStream, and ConsumerMessages.
 *
 * Run: npm run test:api -- workflow-dispatcher
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { NatsConnection } from 'nats';

import { WorkflowDispatcher } from '../../src/workflow-dispatcher.js';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a controllable async iterable that blocks until closed.
 * Calling close() causes the for-await loop to end cleanly.
 */
function makeControllableMessages() {
  let closeResolve: (() => void) | null = null;
  const closePromise = new Promise<void>(r => { closeResolve = r; });

  const messages = {
    close: vi.fn(() => { closeResolve?.(); }),
    [Symbol.asyncIterator]: async function* () {
      // Yield nothing — just block until closed
      await closePromise;
    },
  };

  return messages;
}

function makeMockNats(isClosed = false) {
  const messages = makeControllableMessages();

  const consumer = {
    consume: vi.fn().mockResolvedValue(messages),
  };

  const js = {
    consumers: {
      get: vi.fn().mockResolvedValue(consumer),
    },
    publish: vi.fn().mockResolvedValue(undefined),
  };

  const jsm = {
    consumers: {
      info: vi.fn().mockRejectedValue(new Error('not found')), // force creation
      add: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };

  const nc = {
    isClosed: vi.fn().mockReturnValue(isClosed),
    jetstream: vi.fn().mockReturnValue(js),
    jetstreamManager: vi.fn().mockResolvedValue(jsm),
  } as unknown as NatsConnection;

  return { nc, js, jsm, consumer, messages };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowDispatcher — loop cancellation', () => {
  let dispatcher: WorkflowDispatcher;
  let mocks: ReturnType<typeof makeMockNats>;

  beforeEach(() => {
    mocks = makeMockNats();
    dispatcher = new WorkflowDispatcher(mocks.nc, () => new Map());
  });

  // T1 — Register a route, verify activeLoops has an entry
  test('T1: registerEntrypointRoute stores an active loop entry', async () => {
    await dispatcher.registerEntrypointRoute('team.inbox', 'agent.worker-1.entrypoint');

    const keys = dispatcher.activeRouteKeys;
    expect(keys).toContain('team.inbox=>agent.worker-1.entrypoint');
    expect(keys).toHaveLength(1);
  });

  // T2 — unregisterEntrypointRoute stops the loop and removes the map entry
  test('T2: unregisterEntrypointRoute stops the loop and removes it from activeRouteKeys', async () => {
    await dispatcher.registerEntrypointRoute('team.inbox', 'agent.worker-1.entrypoint');
    expect(dispatcher.activeRouteKeys).toHaveLength(1);

    // Unregister — this must resolve (not hang)
    await dispatcher.unregisterEntrypointRoute('team.inbox', 'agent.worker-1.entrypoint');

    expect(dispatcher.activeRouteKeys).toHaveLength(0);
    expect(mocks.messages.close).toHaveBeenCalled();
  });

  // T3 — Re-registration after unregister creates a fresh loop (not idempotent no-op)
  test('T3: re-registering after unregister creates a new loop', async () => {
    await dispatcher.registerEntrypointRoute('team.inbox', 'agent.worker-1.entrypoint');
    await dispatcher.unregisterEntrypointRoute('team.inbox', 'agent.worker-1.entrypoint');

    // Create fresh mocks for the second registration (new consumer)
    const messages2 = makeControllableMessages();
    const consumer2 = { consume: vi.fn().mockResolvedValue(messages2) };
    (mocks.nc.jetstream() as ReturnType<NatsConnection['jetstream']> & { consumers: { get: ReturnType<typeof vi.fn> } })
      .consumers.get.mockResolvedValue(consumer2);

    await dispatcher.registerEntrypointRoute('team.inbox', 'agent.worker-1.entrypoint');
    expect(dispatcher.activeRouteKeys).toContain('team.inbox=>agent.worker-1.entrypoint');
    expect(dispatcher.activeRouteKeys).toHaveLength(1);
  });

  // T4 — register() (dispatch) stores a loop entry under dispatch: key
  test('T4: register() stores a dispatch loop entry', async () => {
    await dispatcher.register('team.task', { strategy: 'round-robin', to: ['worker-1'] });

    const keys = dispatcher.activeRouteKeys;
    expect(keys).toContain('dispatch:team.task');
    expect(keys).toHaveLength(1);
  });

  // T5 — unregisterDispatch stops the loop
  test('T5: unregisterDispatch stops the dispatch loop', async () => {
    await dispatcher.register('team.task', { strategy: 'round-robin', to: ['worker-1'] });
    expect(dispatcher.activeRouteKeys).toHaveLength(1);

    await dispatcher.unregisterDispatch('team.task');

    expect(dispatcher.activeRouteKeys).toHaveLength(0);
    expect(mocks.messages.close).toHaveBeenCalled();
  });
});

describe('WorkflowDispatcher — stopAll()', () => {
  test('T6: stopAll() stops all loops and clears activeRouteKeys', async () => {
    // Each registration needs its own set of mocks (own consumer messages)
    const messages1 = makeControllableMessages();
    const messages2 = makeControllableMessages();
    const messages3 = makeControllableMessages();

    let callCount = 0;
    const allMessages = [messages1, messages2, messages3];

    const nc = {
      isClosed: vi.fn().mockReturnValue(false),
      jetstream: vi.fn().mockReturnValue({
        consumers: {
          get: vi.fn().mockImplementation(() =>
            Promise.resolve({ consume: vi.fn().mockResolvedValue(allMessages[callCount++]) })
          ),
        },
        publish: vi.fn().mockResolvedValue(undefined),
      }),
      jetstreamManager: vi.fn().mockResolvedValue({
        consumers: {
          info: vi.fn().mockRejectedValue(new Error('not found')),
          add: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
        },
      }),
    } as unknown as NatsConnection;

    const dispatcher2 = new WorkflowDispatcher(nc, () => new Map());

    await dispatcher2.registerEntrypointRoute('a.inbox', 'agent.a.entry');
    await dispatcher2.register('b.task', { strategy: 'round-robin', to: ['b-1'] });
    await dispatcher2.registerEntrypointRoute('c.inbox', 'agent.c.entry');

    expect(dispatcher2.activeRouteKeys).toHaveLength(3);

    await dispatcher2.stopAll();

    expect(dispatcher2.activeRouteKeys).toHaveLength(0);
    // All three messages objects should have had close() called
    expect(messages1.close).toHaveBeenCalled();
    expect(messages2.close).toHaveBeenCalled();
    expect(messages3.close).toHaveBeenCalled();
  });
});
