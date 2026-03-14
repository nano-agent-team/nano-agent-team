/**
 * NATS trace context propagation for agent-runner.
 * Mirrors core's nats-context.ts — kept separate to avoid shared package overhead.
 */

import { isTracingEnabled } from './init.js';

// Eagerly resolve OTel API if tracing is enabled
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

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  sessionId?: string;
}

/** Inject W3C trace context + session ID into NATS headers */
export function injectTraceContext(headers: NatsHeaders, sessionId?: string): void {
  if (sessionId) {
    headers.set('x-session-id', sessionId);
  }
  if (!api) return;

  try {
    const activeSpan = api.trace.getActiveSpan();
    if (!activeSpan) return;

    const ctx = activeSpan.spanContext();
    if (!ctx || !api.isSpanContextValid(ctx)) return;

    const flags = ctx.traceFlags.toString(16).padStart(2, '0');
    headers.set('traceparent', `00-${ctx.traceId}-${ctx.spanId}-${flags}`);
  } catch { /* noop */ }
}

/** Extract W3C trace context from NATS headers */
export function extractTraceContext(headers: NatsHeaders): TraceContext | null {
  const sessionId = headers.get('x-session-id') ?? undefined;
  const traceparent = headers.get('traceparent');

  if (!traceparent) {
    return sessionId ? { traceId: '', spanId: '', traceFlags: 0, sessionId } : null;
  }

  const parts = traceparent.split('-');
  if (parts.length !== 4) return null;

  return {
    traceId: parts[1],
    spanId: parts[2],
    traceFlags: parseInt(parts[3], 16),
    sessionId,
  };
}

/** Start a child span from extracted NATS trace context */
export function startSpan(
  name: string,
  traceContext: TraceContext | null,
  attributes?: Record<string, string>,
): { span: import('@opentelemetry/api').Span; context: import('@opentelemetry/api').Context; end: () => void } | null {
  if (!api || !traceContext?.traceId) return null;

  try {
    const tracer = api.trace.getTracer('nano-agent-runner');
    const remoteCtx = api.trace.setSpanContext(api.context.active(), {
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      traceFlags: traceContext.traceFlags,
      isRemote: true,
    });

    const span = tracer.startSpan(name, { attributes }, remoteCtx);
    const context = api.trace.setSpan(remoteCtx, span);

    if (traceContext.sessionId) {
      span.setAttribute('session.id', traceContext.sessionId);
    }

    return { span, context, end: () => span.end() };
  } catch {
    return null;
  }
}

/** Start a child span within an existing context */
export function startChildSpan(
  name: string,
  parentContext: import('@opentelemetry/api').Context,
  attributes?: Record<string, string>,
): { span: import('@opentelemetry/api').Span; context: import('@opentelemetry/api').Context; end: () => void } | null {
  if (!api) return null;

  try {
    const tracer = api.trace.getTracer('nano-agent-runner');
    const span = tracer.startSpan(name, { attributes }, parentContext);
    const context = api.trace.setSpan(parentContext, span);
    return { span, context, end: () => span.end() };
  } catch {
    return null;
  }
}

/** Get the OTel API module (if loaded) */
export function getOtelApi(): typeof import('@opentelemetry/api') | null {
  return api;
}
