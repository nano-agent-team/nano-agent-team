/**
 * Embedded NATS server
 *
 * Spawns nats-server as a child process before the main app connects.
 * Used in Docker deployments where no external NATS is available.
 *
 * The binary must be available as `nats-server` on PATH
 * (installed via apk in Dockerfile: apk add nats-server).
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import net from 'net';

const NATS_PORT = 4222;
const STARTUP_TIMEOUT_MS = 8000;

let natsProcess: ChildProcess | null = null;

/** Single-shot, non-retrying TCP probe — resolves true if port is open */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/** Simple promise-based sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until TCP port is accepting connections */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function attempt() {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`nats-server did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    }

    attempt();
  });
}

export async function startEmbeddedNats(): Promise<string> {
  // Fast path: we already spawned NATS in this process
  if (natsProcess !== null && natsProcess.exitCode === null) {
    try {
      await waitForPort(NATS_PORT, 500);
      console.log('[nats-embedded] NATS (self-spawned) still running — reusing');
      return `nats://localhost:${NATS_PORT}`;
    } catch {
      // Process handle exists but port not responding — stale handle, clear it
      console.warn('[nats-embedded] Self-spawned NATS not responding — will restart');
      natsProcess.kill('SIGKILL');
      natsProcess = null;
    }
  }

  // If we reach here, natsProcess is null. Check if something else owns the port.
  const portOpen = await isPortOpen(NATS_PORT);
  if (portOpen) {
    console.warn('[nats-embedded] Orphan NATS detected on port 4222 — killing');
    try {
      execSync(`fuser -k ${NATS_PORT}/tcp 2>/dev/null || true`);
      // Give OS a moment to release the port
      await sleep(500);
    } catch {
      console.error('[nats-embedded] Failed to kill orphan process on port 4222');
      throw new Error(
        `Port ${NATS_PORT} is in use by an external process. ` +
        `Kill it manually: fuser -k ${NATS_PORT}/tcp`,
      );
    }
  }

  console.log('[nats-embedded] Starting embedded NATS server...');

  natsProcess = spawn('nats-server', ['-p', String(NATS_PORT), '-js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  natsProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('[nats-server]', line);
    }
  });

  natsProcess.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line && !line.includes('started')) {
      console.error('[nats-server]', line);
    }
  });

  natsProcess.on('exit', (code, signal) => {
    console.error(`[nats-embedded] nats-server exited: code=${code} signal=${signal}`);
    natsProcess = null;
  });

  // Wait for NATS to accept connections
  await waitForPort(NATS_PORT, STARTUP_TIMEOUT_MS);
  console.log(`[nats-embedded] NATS server ready on :${NATS_PORT}`);

  return `nats://localhost:${NATS_PORT}`;
}

export function stopEmbeddedNats(): void {
  if (natsProcess) {
    natsProcess.kill('SIGTERM');
    natsProcess = null;
  }
  // Belt-and-suspenders: also kill anything on the port
  try {
    execSync(`fuser -k ${NATS_PORT}/tcp 2>/dev/null || true`);
  } catch { /* ignore */ }
}
