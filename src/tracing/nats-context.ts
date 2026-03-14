/**
 * NATS trace context propagation helpers.
 *
 * Injects/extracts W3C traceparent headers into NATS message headers
 * for distributed tracing across core -> agent -> agent chains.
 *
 * Graceful no-op when OTel is not initialized.
 */

import { isTracingEnabled } from './init.js';

// Eagerly resolve OTel API if tracing is enabled (module already loaded by init.ts)
let api: typeof import('@opentelemetry/api') | null = null;
if (isTracingEnabled()) {
  try {
    api = await import('@opentelemetry/api');
  } catch {
    api = null;
  }
}

interface NatsHeaders {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/**
 * Inject W3C trace context into NATS headers.
 * If OTel is not active, only injects x-session-id (if provided).
 */
export function injectTraceContext(
  headers: NatsHeaders,
  sessionId?: string,
): void {
  if (sessionId) {
    headers.set('x-session-id', sessionId);
  }

  if (!api) return;

  try {
    const activeSpan = api.trace.getActiveSpan();
    if (!activeSpan) return;

    const spanContext = activeSpan.spanContext();
    if (!spanContext || !api.isSpanContextValid(spanContext)) return;

    // W3C traceparent format: version-traceId-spanId-traceFlags
    const flags = spanContext.traceFlags.toString(16).padStart(2, '0');
    const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
    headers.set('traceparent', traceparent);
  } catch {
    // Graceful noop
  }
}

/**
 * Extract W3C trace context from NATS message headers.
 * Returns parsed context or null if no valid trace context found.
 */
export function extractTraceContext(
  headers: NatsHeaders,
): { traceId: string; spanId: string; traceFlags: number; sessionId?: string } | null {
  const sessionId = headers.get('x-session-id') ?? undefined;
  const traceparent = headers.get('traceparent');

  if (!traceparent) {
    return sessionId ? { traceId: '', spanId: '', traceFlags: 0, sessionId } : null;
  }

  // Parse W3C traceparent: 00-traceId-spanId-flags
  const parts = traceparent.split('-');
  if (parts.length !== 4) return null;

  const [, traceId, spanId, flagsHex] = parts;
  const traceFlags = parseInt(flagsHex, 16);

  return { traceId, spanId, traceFlags, sessionId };
}

/**
 * Create a child span linked to extracted NATS trace context.
 * Returns the span and a cleanup function, or null if tracing is not active.
 */
export function startSpanFromNatsContext(
  spanName: string,
  traceContext: { traceId: string; spanId: string; traceFlags: number; sessionId?: string } | null,
  attributes?: Record<string, string>,
): { span: import('@opentelemetry/api').Span; end: () => void } | null {
  if (!api || !traceContext?.traceId) return null;

  try {
    const tracer = api.trace.getTracer('nano-agent-team');

    // Create remote span context as parent
    const remoteContext = api.trace.setSpanContext(api.context.active(), {
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      traceFlags: traceContext.traceFlags,
      isRemote: true,
    });

    const span = tracer.startSpan(spanName, { attributes }, remoteContext);

    if (traceContext.sessionId) {
      span.setAttribute('session.id', traceContext.sessionId);
    }

    return {
      span,
      end: () => span.end(),
    };
  } catch {
    return null;
  }
}

/**
 * Get the OTel tracer (if available). Useful for creating custom spans.
 */
export function getTracer(): import('@opentelemetry/api').Tracer | null {
  if (!api) return null;
  return api.trace.getTracer('nano-agent-team');
}

/**
 * Get the OTel API module (if loaded). Null when tracing is disabled.
 */
export function getOtelApi(): typeof import('@opentelemetry/api') | null {
  return api;
}
