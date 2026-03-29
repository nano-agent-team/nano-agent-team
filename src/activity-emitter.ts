// nano-agent-team/src/activity-emitter.ts
import { NatsConnection, StringCodec } from 'nats';
import { logger } from './logger.js';

const sc = StringCodec();

export interface ActivityEvent {
  agent: string;
  type: 'thinking' | 'dialogue' | 'idea' | 'plan' | 'action' | 'user' | 'reflect';
  entityId?: string;
  summary: string;
  from?: string;
  to?: string;
  subtype?: string;
  timestamp: number;
}

/**
 * Fire-and-forget activity event via NATS core pub/sub.
 * Never throws — errors are logged and swallowed.
 * These events are ephemeral visualization signals, not durable state.
 */
export function emitActivity(nc: NatsConnection, event: ActivityEvent): void {
  try {
    const subject = `activity.${event.type}`;
    nc.publish(subject, sc.encode(JSON.stringify(event)));
  } catch (err) {
    logger.debug({ err, event }, 'Activity event emission failed (non-fatal)');
  }
}
