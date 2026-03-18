/**
 * Workflow Dispatcher
 *
 * Routes NATS messages to specific agent instances based on a dispatch strategy.
 * Handles least-busy and round-robin strategies.
 * Competing and broadcast are handled natively (no dispatcher needed).
 */

import { AckPolicy, DeliverPolicy, type NatsConnection } from 'nats';

import { logger } from './logger.js';
import type { DispatchConfig } from './agent-registry.js';

interface InstanceHeartbeat {
  busy: boolean;
  lastSeen: Date;
}

export class WorkflowDispatcher {
  private roundRobinCounters = new Map<string, number>();

  constructor(
    private nc: NatsConnection,
    private getHeartbeats: () => Map<string, InstanceHeartbeat>,
  ) {}

  /**
   * Register a dispatch rule for a NATS subject.
   * Creates a durable JetStream consumer and starts an async pull loop.
   * Each message is routed to an instance picked by the configured strategy.
   */
  async register(subject: string, config: DispatchConfig): Promise<void> {
    const js = this.nc.jetstream();
    const jsm = await this.nc.jetstreamManager();

    const consumerName = `dispatch-${subject.replace(/\./g, '-')}`;

    // Ensure durable consumer exists
    try {
      await jsm.consumers.info('AGENTS', consumerName);
    } catch {
      await jsm.consumers.add('AGENTS', {
        durable_name: consumerName,
        filter_subject: subject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
      });
    }

    const consumer = await js.consumers.get('AGENTS', consumerName);

    logger.info({ subject, strategy: config.strategy, to: config.to }, 'WorkflowDispatcher: registered dispatch rule');

    // Start async pull loop
    void this.pullLoop(consumer, subject, config);
  }

  private async pullLoop(
    consumer: Awaited<ReturnType<ReturnType<NatsConnection['jetstream']>['consumers']['get']>>,
    subject: string,
    config: DispatchConfig,
  ): Promise<void> {
    try {
      const messages = await consumer.consume({ max_messages: 1 });

      for await (const msg of messages) {
        const instanceId = this.pickInstance(config.strategy, config.to);

        if (!instanceId) {
          // No available instance — nack with delay to keep message in queue
          msg.nak(5000);
          logger.debug({ subject, strategy: config.strategy }, 'WorkflowDispatcher: no available instance — nacking');
          continue;
        }

        try {
          const js = this.nc.jetstream();
          await js.publish(`agent.${instanceId}.inbox`, msg.data, {
            headers: msg.headers,
          });
          msg.ack();
          logger.debug({ subject, instanceId, strategy: config.strategy }, 'WorkflowDispatcher: routed message');
        } catch (err) {
          logger.error({ err, subject, instanceId }, 'WorkflowDispatcher: failed to route message');
          msg.nak();
        }
      }
    } catch (err) {
      logger.error({ err, subject }, 'WorkflowDispatcher: pull loop error');
    }
  }

  private pickInstance(strategy: string, candidates: string[]): string | null {
    if (candidates.length === 0) return null;

    const heartbeats = this.getHeartbeats();

    if (strategy === 'least-busy') {
      // Filter to non-busy instances seen recently (within 60s)
      const cutoff = new Date(Date.now() - 60_000);
      const available = candidates.filter(id => {
        const hb = heartbeats.get(id);
        return hb && !hb.busy && hb.lastSeen >= cutoff;
      });

      if (available.length === 0) return null;

      // Sort by lastSeen ASC (longest idle first)
      available.sort((a, b) => {
        const ha = heartbeats.get(a)!;
        const hb = heartbeats.get(b)!;
        return ha.lastSeen.getTime() - hb.lastSeen.getTime();
      });

      return available[0];
    }

    if (strategy === 'round-robin') {
      const key = candidates.join(',');
      const counter = this.roundRobinCounters.get(key) ?? 0;
      const picked = candidates[counter % candidates.length];
      this.roundRobinCounters.set(key, counter + 1);
      return picked;
    }

    // Fallback: pick first
    return candidates[0];
  }
}
