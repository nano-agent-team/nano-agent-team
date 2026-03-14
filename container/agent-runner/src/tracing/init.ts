/**
 * OTel SDK initialization for agent-runner.
 *
 * Agents don't need HTTP/Express auto-instrumentation (they use manual spans),
 * so we can initialize synchronously at import time.
 *
 * Reads env vars:
 *   OBSERVABILITY_LEVEL — "none" | "logging" | "full"
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP HTTP endpoint
 *   AGENT_ID — service name suffix
 */

const OBSERVABILITY_LEVEL = process.env.OBSERVABILITY_LEVEL ?? 'none';
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
const AGENT_ID = process.env.AGENT_ID ?? 'unknown';

let tracingEnabled = false;

if (OBSERVABILITY_LEVEL === 'full') {
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions');

    const sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: `nano-agent-${AGENT_ID}`,
        [ATTR_SERVICE_VERSION]: '0.1.0',
        'agent.id': AGENT_ID,
      }),
      traceExporter: new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces` }),
    });

    sdk.start();
    tracingEnabled = true;

    const otelApi = await import('@opentelemetry/api');
    (globalThis as Record<string, unknown>).__otelApi = otelApi;
    (globalThis as Record<string, unknown>).__otelTracingEnabled = true;

    process.on('SIGTERM', () => sdk.shutdown().catch(console.error));
    console.error(`[tracing] Agent OTel SDK initialized — ${AGENT_ID} → ${OTLP_ENDPOINT}`);
  } catch (err) {
    console.error('[tracing] Failed to initialize agent OTel SDK:', err);
  }
}

export function isTracingEnabled(): boolean {
  return tracingEnabled;
}
