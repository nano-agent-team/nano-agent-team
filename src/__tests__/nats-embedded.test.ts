/**
 * Unit tests for nats-embedded.ts
 *
 * Uses vi.mock to intercept child_process and net so no real NATS binary
 * or OS network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal fake ChildProcess */
function makeMockProcess(exitCode: number | null = null): ChildProcess {
  return {
    exitCode,
    kill: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    pid: 99999,
  } as unknown as ChildProcess;
}

/**
 * Build a fake socket factory for net.createConnection.
 * `behaviour` controls what event fires:
 *   'connect' → fires the 'connect' handler (port open)
 *   'error'   → fires the 'error' handler   (port closed / ECONNREFUSED)
 *   'timeout' → fires the 'timeout' handler  (connection timed out)
 */
function makeSocketFactory(behaviour: 'connect' | 'error' | 'timeout') {
  return () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const sock = {
      on(ev: string, fn: (...args: unknown[]) => void) {
        handlers[ev] = fn;
        if (ev === behaviour) {
          setTimeout(() => fn(behaviour === 'error' ? new Error('ECONNREFUSED') : undefined), 0);
        }
        return sock;
      },
      setTimeout: vi.fn(),
      destroy: vi.fn(),
    };
    return sock;
  };
}

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('net', () => {
  const createConnection = vi.fn();
  return { default: { createConnection } };
});

// ── test suite ────────────────────────────────────────────────────────────────

describe('nats-embedded', () => {
  // Re-import the module fresh for every test so the module-level
  // `natsProcess` variable is reset to null between tests.
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  // ── Test 1: reuse self-spawned NATS ────────────────────────────────────────
  it('reuses a self-spawned NATS process that is still alive', async () => {
    const cpMod = await import('child_process');
    const netMod = await import('net');

    const mockProc = makeMockProcess(null /* still running */);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cpMod.spawn as any).mockReturnValue(mockProc);

    // All socket connections → port responds (connect)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (netMod.default.createConnection as any).mockImplementation(makeSocketFactory('connect'));

    const { startEmbeddedNats } = await import('../nats-embedded.js');

    // First call: fresh spawn (natsProcess null, port closed → isPortOpen → first
    //             connection in clean path; after spawn → waitForPort → connect)
    // Note: on first call natsProcess is null so we go through isPortOpen first.
    // We need port *closed* for isPortOpen (no orphan), then *open* after spawn.
    // Re-mock createConnection with a sequence:
    let callIdx = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (netMod.default.createConnection as any).mockImplementation(() => {
      callIdx++;
      // call 1 → isPortOpen → port closed (no orphan)
      // call 2+ → waitForPort after spawn → port open
      return makeSocketFactory(callIdx === 1 ? 'error' : 'connect')();
    });

    const url1 = await startEmbeddedNats();
    expect(url1).toBe('nats://localhost:4222');
    expect(cpMod.spawn).toHaveBeenCalledTimes(1);

    // Second call: natsProcess !== null and alive → fast path reuse
    // Now all connections respond (port is open)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (netMod.default.createConnection as any).mockImplementation(makeSocketFactory('connect'));

    const url2 = await startEmbeddedNats();
    expect(url2).toBe('nats://localhost:4222');
    // spawn must NOT have been called a second time
    expect(cpMod.spawn).toHaveBeenCalledTimes(1);
    // execSync (fuser) must not have been called
    expect(cpMod.execSync).not.toHaveBeenCalled();
  });

  // ── Test 2: orphan detection and kill ──────────────────────────────────────
  it('detects an orphan on port 4222 and kills it before spawning', async () => {
    const cpMod = await import('child_process');
    const netMod = await import('net');

    const mockProc = makeMockProcess(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cpMod.spawn as any).mockReturnValue(mockProc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cpMod.execSync as any).mockReturnValue(Buffer.from(''));

    // isPortOpen → connect (orphan present), then waitForPort after spawn → connect
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (netMod.default.createConnection as any).mockImplementation(makeSocketFactory('connect'));

    const { startEmbeddedNats } = await import('../nats-embedded.js');
    const url = await startEmbeddedNats();

    expect(url).toBe('nats://localhost:4222');
    // fuser must have been called to kill the orphan
    expect(cpMod.execSync).toHaveBeenCalledWith(
      expect.stringContaining('fuser -k 4222/tcp'),
    );
    // spawn must have been called to start a fresh NATS
    expect(cpMod.spawn).toHaveBeenCalledTimes(1);
  });

  // ── Test 3: clean start (no orphan) ────────────────────────────────────────
  it('spawns NATS directly when port is closed (clean state)', async () => {
    const cpMod = await import('child_process');
    const netMod = await import('net');

    const mockProc = makeMockProcess(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cpMod.spawn as any).mockReturnValue(mockProc);

    // isPortOpen → error (port closed); waitForPort after spawn → connect
    let callIdx = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (netMod.default.createConnection as any).mockImplementation(() => {
      callIdx++;
      return makeSocketFactory(callIdx === 1 ? 'error' : 'connect')();
    });

    const { startEmbeddedNats } = await import('../nats-embedded.js');
    const url = await startEmbeddedNats();

    expect(url).toBe('nats://localhost:4222');
    // No orphan → fuser not called
    expect(cpMod.execSync).not.toHaveBeenCalled();
    // spawn called exactly once
    expect(cpMod.spawn).toHaveBeenCalledTimes(1);
  });

  // ── Test 4: stale handle recovery ──────────────────────────────────────────
  it('kills a stale process handle whose port is no longer responding, then spawns fresh', async () => {
    const cpMod = await import('child_process');
    const netMod = await import('net');

    const proc1 = makeMockProcess(null);
    const proc2 = makeMockProcess(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cpMod.spawn as any)
      .mockReturnValueOnce(proc1)
      .mockReturnValueOnce(proc2);

    // Deterministic sequence of socket behaviours across all createConnection calls:
    //
    // First startEmbeddedNats() (natsProcess = null, clean state):
    //   call 1: isPortOpen          → error   (port closed, no orphan)
    //   call 2: waitForPort attempt → connect (proc1 up)
    //
    // Second startEmbeddedNats() (natsProcess = proc1, stale):
    //   calls 3-6: fast-path waitForPort retries (500ms / 200ms retry ≈ 4 attempts)
    //              → all error so the promise rejects with timeout
    //   call 7: isPortOpen after kill → error (port free)
    //   call 8: waitForPort after spawn proc2 → connect
    const behaviours: Array<'connect' | 'error'> = [
      'error',   // 1: isPortOpen (first start) → closed
      'connect', // 2: waitForPort (first start) → ok
      'error',   // 3: fast-path waitForPort attempt 1 (stale)
      'error',   // 4: fast-path waitForPort attempt 2
      'error',   // 5: fast-path waitForPort attempt 3
      'error',   // 6: fast-path waitForPort attempt 4 (timeout fires)
      'error',   // 7: isPortOpen (after kill) → closed
      'connect', // 8: waitForPort (after re-spawn) → ok
    ];
    let callIdx = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (netMod.default.createConnection as any).mockImplementation(() => {
      const behaviour = behaviours[callIdx] ?? 'connect';
      callIdx++;
      return makeSocketFactory(behaviour)();
    });

    const { startEmbeddedNats } = await import('../nats-embedded.js');

    // First call: fresh spawn
    await startEmbeddedNats();
    expect(cpMod.spawn).toHaveBeenCalledTimes(1);

    // Second call: natsProcess = proc1 but fast-path waitForPort times out → stale
    const url2 = await startEmbeddedNats();
    expect(url2).toBe('nats://localhost:4222');
    // proc1 must have been killed with SIGKILL
    expect(proc1.kill).toHaveBeenCalledWith('SIGKILL');
    // spawn called a second time for the fresh instance
    expect(cpMod.spawn).toHaveBeenCalledTimes(2);
    // port was closed after killing stale handle — fuser not needed
    expect(cpMod.execSync).not.toHaveBeenCalled();
  });

  // ── Test 5: stopEmbeddedNats calls fuser ────────────────────────────────────
  it('stopEmbeddedNats calls fuser as belt-and-suspenders fallback', async () => {
    const cpMod = await import('child_process');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cpMod.execSync as any).mockReturnValue(Buffer.from(''));

    const { stopEmbeddedNats } = await import('../nats-embedded.js');
    stopEmbeddedNats();

    expect(cpMod.execSync).toHaveBeenCalledWith(
      expect.stringContaining('fuser -k 4222/tcp'),
    );
  });
});
