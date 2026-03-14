/**
 * OTel SDK registration — loaded via node --import before any app code.
 *
 * No HTTP auto-instrumentation — we trace NATS messages manually instead.
 * This just sets up the SDK, exporter, and exposes the API on globalThis.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

function loadObsConfig() {
  const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), 'nano-agent-team', 'data');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return config?.observability ?? { level: 'none' };
  } catch { return { level: 'none' }; }
}

const obs = loadObsConfig();

if (obs.level === 'full') {
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { Resource } = await import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions');

  const rawEp = obs.endpoints?.otlp ?? 'http://tempo:4318';
  const endpoint = rawEp.replace('://tempo:', '://localhost:').replace('://loki:', '://localhost:');

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: 'nano-core',
      [ATTR_SERVICE_VERSION]: '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    // No instrumentations — we trace NATS messages manually
  });

  sdk.start();

  const otelApi = await import('@opentelemetry/api');
  globalThis.__otelApi = otelApi;
  globalThis.__otelTracingEnabled = true;

  process.on('SIGTERM', () => sdk.shutdown().catch(console.error));
  console.log(`[tracing] OTel SDK registered — NATS tracing → ${endpoint}`);
} else {
  globalThis.__otelTracingEnabled = false;
}
