/**
 * NATS JetStream client for nano-agent-team.
 *
 * Provides connect, stream management, publish and subscribe helpers.
 *
 * Streams:
 *   AGENTS  — subjects: agent.>, topic.>
 *             Limits retention, 24h max age, file storage
 *
 * Usage:
 *   const nc = await connectNats(NATS_URL);
 *   await ensureStream('AGENTS', ['agent.>', 'topic.>']);
 *   await publish(nc, 'agent.blank-agent.inbox', '{"text":"hello"}');
 */

import {
  AckPolicy,
  connect,
  headers as natsHeaders,
  NatsConnection,
  RetentionPolicy,
  StorageType,
  StringCodec,
  JetStreamClient,
  ConsumerConfig,
  MsgHdrs,
} from 'nats';

import { logger } from './logger.js';
import { injectTraceContext } from './tracing/nats-context.js';

// ─── Ticket trace correlation ─────────────────────────────────────────────────
// Maps ticket_id → root span context, so all NATS publishes for the same ticket
// become child spans of one distributed trace (the ticket lifecycle).
const ticketTraceRoots = new Map<string, { traceId: string; spanId: string }>();

export const codec = StringCodec();

/**
 * Connect to NATS server at given URL.
 * Logs connect and close events.
 */
export async function connectNats(url: string): Promise<NatsConnection> {
  const nc = await connect({ servers: url, name: 'nano-agent-team' });

  logger.info({ url }, 'Connected to NATS');

  // Log when connection closes
  void nc.closed().then((err) => {
    if (err) logger.warn({ err }, 'NATS connection closed with error');
    else logger.info('NATS connection closed');
  });

  return nc;
}

/**
 * Get JetStream client from a NatsConnection.
 */
export function getJetStream(nc: NatsConnection): JetStreamClient {
  return nc.jetstream();
}

/**
 * Ensure a JetStream stream exists with the given subjects.
 * Creates the stream if it doesn't exist; updates subjects if it does.
 * Idempotent.
 */
export async function ensureStream(
  nc: NatsConnection,
  name: string,
  subjects: string[],
): Promise<void> {
  const jsm = await nc.jetstreamManager();

  try {
    await jsm.streams.add({
      name,
      subjects,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: 24 * 60 * 60 * 1_000_000_000, // 24h in nanoseconds
      max_bytes: 512 * 1024 * 1024,            // 512MB
      num_replicas: 1,
    });
    logger.info({ stream: name, subjects }, 'Stream created');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('stream name already in use')) {
      // Stream exists — update subjects (idempotent)
      await jsm.streams.update(name, { subjects }).catch(() => {});
      logger.debug({ stream: name }, 'Stream already exists');
    } else {
      throw err;
    }
  }
}

/**
 * Ensure a durable consumer exists for the given agent on a stream.
 * Consumer filters to the agent's subscribe_topics.
 */
export async function ensureConsumer(
  nc: NatsConnection,
  streamName: string,
  agentId: string,
  filterSubjects: string[],
): Promise<void> {
  const jsm = await nc.jetstreamManager();
  const consumerName = agentId;

  const config: Partial<ConsumerConfig> = {
    durable_name: consumerName,
    ack_policy: AckPolicy.Explicit,
    max_deliver: 3,
    ack_wait: 600_000_000_000, // 10 min in nanoseconds (agents may run long tasks)
  };

  // Use filter_subjects (multiple) if supported, else single filter_subject
  if (filterSubjects.length === 1) {
    (config as Record<string, unknown>).filter_subject = filterSubjects[0];
  } else {
    (config as Record<string, unknown>).filter_subjects = filterSubjects;
  }

  // Check if an existing consumer has different filter subjects — JetStream cannot
  // update filter_subject(s) in place, so we must delete and recreate.
  let needsRecreate = false;
  try {
    const existing = await jsm.consumers.info(streamName, consumerName);
    const existingFilters: string[] =
      existing.config.filter_subjects ??
      (existing.config.filter_subject ? [existing.config.filter_subject] : []);
    const sorted = (a: string[]) => [...a].sort().join(',');
    if (sorted(existingFilters) !== sorted(filterSubjects)) {
      needsRecreate = true;
      await jsm.consumers.delete(streamName, consumerName);
      logger.debug({ agentId, old: existingFilters, new: filterSubjects }, 'Consumer filter changed — deleted for recreation');
    }
  } catch {
    // Consumer doesn't exist yet — will be created below
  }

  try {
    await jsm.consumers.add(streamName, config as ConsumerConfig);
    logger.debug({ agentId, filterSubjects, recreated: needsRecreate }, 'Consumer created');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('consumer name already in use') || msg.includes('consumer already exists')) {
      // Consumer exists with correct filters — update other config fields
      try {
        await jsm.consumers.update(streamName, consumerName, config as ConsumerConfig);
        logger.debug({ agentId }, 'Consumer updated');
      } catch {
        logger.debug({ agentId }, 'Consumer already exists (update skipped)');
      }
    } else {
      logger.warn({ err, agentId }, 'Failed to create consumer');
    }
  }
}

/**
 * Publish a JSON payload to a NATS JetStream subject.
 * Creates an OTel span for each publish — this IS the business trace.
 * Injects W3C trace context into NATS headers for distributed tracing.
 */
export async function publish(
  nc: NatsConnection,
  subject: string,
  payload: string,
  sessionId?: string,
): Promise<void> {
  const js = nc.jetstream();
  const hdrs = natsHeaders();

  // Extract business context from payload for meaningful span names
  let ticketId = '';
  let ticketTitle = '';
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    ticketId = (parsed.ticket_id as string) ?? '';
    ticketTitle = (parsed.title as string)
      ?? ((parsed.ticket as Record<string, unknown>)?.title as string)
      ?? '';
  } catch { /* not JSON or no ticket context */ }

  // Build human-readable span name: "topic.ticket.new TICK-001 (Deploy login page)"
  let spanName = subject;
  if (ticketId) {
    spanName = ticketTitle
      ? `${subject} ${ticketId} (${ticketTitle})`
      : `${subject} ${ticketId}`;
  }

  // Create OTel span for this NATS publish
  const otelApi = (globalThis as Record<string, unknown>).__otelApi as typeof import('@opentelemetry/api') | undefined;
  let span: import('@opentelemetry/api').Span | undefined;

  if (otelApi && (globalThis as Record<string, unknown>).__otelTracingEnabled) {
    const tracer = otelApi.trace.getTracer('nano-nats');

    // For ticket-related messages: reuse the same trace across the entire lifecycle
    // topic.ticket.new → topic.ticket.approved → topic.ticket.spec-ready → ...
    // all become spans under ONE trace for that ticket.
    const existingRoot = ticketId ? ticketTraceRoots.get(ticketId) : undefined;

    if (existingRoot) {
      // Create child span linked to the ticket's root trace
      const parentCtx = otelApi.trace.setSpanContext(otelApi.context.active(), {
        traceId: existingRoot.traceId,
        spanId: existingRoot.spanId,
        traceFlags: 1,
        isRemote: false,
      });
      span = tracer.startSpan(spanName, {
        attributes: {
          'nats.subject': subject,
          ...(ticketId ? { 'ticket.id': ticketId } : {}),
          ...(ticketTitle ? { 'ticket.title': ticketTitle } : {}),
          'messaging.system': 'nats',
        },
      }, parentCtx);
    } else {
      // New root span (first publish for this ticket, or non-ticket message)
      span = tracer.startSpan(spanName, {
        attributes: {
          'nats.subject': subject,
          ...(ticketId ? { 'ticket.id': ticketId } : {}),
          ...(ticketTitle ? { 'ticket.title': ticketTitle } : {}),
          'messaging.system': 'nats',
        },
      });

      // Store root context for subsequent publishes on the same ticket
      if (ticketId) {
        const spanCtx = span.spanContext();
        ticketTraceRoots.set(ticketId, { traceId: spanCtx.traceId, spanId: spanCtx.spanId });
      }
    }
  }

  // Inject trace context (including the new span) into NATS headers
  const headerAdapter = {
    get: (key: string) => hdrs.get(key),
    set: (key: string, value: string) => hdrs.set(key, value),
  };

  if (span && otelApi) {
    const ctx = otelApi.trace.setSpan(otelApi.context.active(), span);
    otelApi.context.with(ctx, () => {
      injectTraceContext(headerAdapter, sessionId);
    });
  } else {
    injectTraceContext(headerAdapter, sessionId);
  }

  try {
    await js.publish(subject, codec.encode(payload), { headers: hdrs });
    logger.debug({ subject }, 'Published');
  } finally {
    span?.end();
  }
}

/**
 * Subscribe to a core NATS subject (non-JetStream).
 * Useful for health checks and fire-and-forget patterns.
 */
export function subscribe(
  nc: NatsConnection,
  subject: string,
  handler: (data: string, headers?: MsgHdrs) => void,
): void {
  const sub = nc.subscribe(subject);
  void (async () => {
    for await (const msg of sub) {
      handler(codec.decode(msg.data), msg.headers);
    }
  })();
}

/**
 * Extract trace context from NATS message headers.
 * Re-exports for convenience.
 */
export { extractTraceContext } from './tracing/nats-context.js';

/**
 * Drain and close the NATS connection gracefully.
 */
export async function closeNats(nc: NatsConnection): Promise<void> {
  await nc.drain();
}
