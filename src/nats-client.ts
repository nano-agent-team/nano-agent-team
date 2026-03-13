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
  NatsConnection,
  RetentionPolicy,
  StorageType,
  StringCodec,
  JetStreamClient,
  ConsumerConfig,
} from 'nats';

import { logger } from './logger.js';

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
    ack_wait: 30_000_000_000, // 30s in nanoseconds
  };

  // Use filter_subjects (multiple) if supported, else single filter_subject
  if (filterSubjects.length === 1) {
    (config as Record<string, unknown>).filter_subject = filterSubjects[0];
  } else {
    (config as Record<string, unknown>).filter_subjects = filterSubjects;
  }

  try {
    await jsm.consumers.add(streamName, config as ConsumerConfig);
    logger.debug({ agentId, filterSubjects }, 'Consumer created');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('consumer name already in use')) {
      logger.warn({ err, agentId }, 'Failed to create consumer');
    } else {
      logger.debug({ agentId }, 'Consumer already exists');
    }
  }
}

/**
 * Publish a JSON payload to a NATS JetStream subject.
 */
export async function publish(
  nc: NatsConnection,
  subject: string,
  payload: string,
): Promise<void> {
  const js = nc.jetstream();
  await js.publish(subject, codec.encode(payload));
  logger.debug({ subject }, 'Published');
}

/**
 * Subscribe to a core NATS subject (non-JetStream).
 * Useful for health checks and fire-and-forget patterns.
 */
export function subscribe(
  nc: NatsConnection,
  subject: string,
  handler: (data: string) => void,
): void {
  const sub = nc.subscribe(subject);
  void (async () => {
    for await (const msg of sub) {
      handler(codec.decode(msg.data));
    }
  })();
}

/**
 * Drain and close the NATS connection gracefully.
 */
export async function closeNats(nc: NatsConnection): Promise<void> {
  await nc.drain();
}
