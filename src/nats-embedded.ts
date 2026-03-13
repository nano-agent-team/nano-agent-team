/**
 * Embedded NATS server
 *
 * Spawns nats-server as a child process before the main app connects.
 * Used in Docker deployments where no external NATS is available.
 *
 * The binary must be available as `nats-server` on PATH
 * (installed via apk in Dockerfile: apk add nats-server).
 */

import { spawn, type ChildProcess } from 'child_process';
import net from 'net';

const NATS_PORT = 4222;
const STARTUP_TIMEOUT_MS = 8000;

let natsProcess: ChildProcess | null = null;

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
  // Check if NATS is already running on the port
  try {
    await waitForPort(NATS_PORT, 500);
    console.log('[nats-embedded] NATS already running — skipping embedded start');
    return `nats://localhost:${NATS_PORT}`;
  } catch {
    // Not running — start embedded
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
}
