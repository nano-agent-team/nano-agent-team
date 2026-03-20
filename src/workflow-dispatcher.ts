/**
 * Workflow Dispatcher
 *
 * Routes NATS messages to specific agent instances based on a dispatch strategy.
 * Handles least-busy and round-robin strategies.
 * Competing and broadcast are handled natively (no dispatcher needed).
 */

import { AckPolicy, DeliverPolicy, type NatsConnection, type ConsumerMessages } from 'nats';

import { logger } from './logger.js';
import type { DispatchConfig } from './agent-registry.js';

interface InstanceHeartbeat {
  busy: boolean;
  lastSeen: Date;
}

interface ActiveLoop {
  /** Call to stop the consume loop and exit runWithBackoff */
  stop: () => void;
  /** Resolves when the loop has fully exited */
  done: Promise<void>;
  /** The JetStream consumer name (needed for optional cleanup) */
  consumerName: string;
}

export class WorkflowDispatcher {
  private roundRobinCounters = new Map<string, number>();
  private activeLoops = new Map<string, ActiveLoop>();

  constructor(
    private nc: NatsConnection,
    private getHeartbeats: () => Map<string, InstanceHeartbeat>,
  ) {}

  /**
   * Register a 1-to-1 entrypoint route: external subject → agent entrypoint subject.
   * Creates a durable JetStream consumer on `from` and forwards every message to `toSubject`.
   * Used for { from, to } binding inputs — agent subscribes to toSubject, not to `from`.
   * Idempotent: repeated calls with the same from/toSubject pair are no-ops.
   */
  async registerEntrypointRoute(from: string, toSubject: string): Promise<void> {
    const key = `${from}=>${toSubject}`;
    if (this.activeLoops.has(key)) return;

    const js = this.nc.jetstream();
    const jsm = await this.nc.jetstreamManager();

    const consumerName = `ep-${from.replace(/\./g, '-')}`;

    try {
      await jsm.consumers.info('AGENTS', consumerName);
    } catch {
      await jsm.consumers.add('AGENTS', {
        durable_name: consumerName,
        filter_subject: from,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
      });
    }

    const consumer = await js.consumers.get('AGENTS', consumerName);
    logger.info({ from, toSubject }, 'WorkflowDispatcher: registered entrypoint route');

    const signal = { aborted: false };
    const messagesRef: { current: ConsumerMessages | null } = { current: null };

    const done = this.runWithBackoff(
      () => this.entrypointRouteLoop(consumer, from, toSubject, messagesRef),
      `entrypoint:${key}`,
      signal,
    );

    this.activeLoops.set(key, {
      stop: () => {
        signal.aborted = true;
        messagesRef.current?.close();
      },
      done,
      consumerName,
    });
  }

  private async entrypointRouteLoop(
    consumer: Awaited<ReturnType<ReturnType<NatsConnection['jetstream']>['consumers']['get']>>,
    from: string,
    toSubject: string,
    messagesRef: { current: ConsumerMessages | null },
  ): Promise<void> {
    const messages = await consumer.consume({ max_messages: 1 });
    messagesRef.current = messages;
    for await (const msg of messages) {
      try {
        const js = this.nc.jetstream();
        await js.publish(toSubject, msg.data, { headers: msg.headers });
        msg.ack();
        logger.debug({ from, toSubject }, 'WorkflowDispatcher: forwarded to entrypoint');
      } catch (err) {
        logger.error({ err, from, toSubject }, 'WorkflowDispatcher: entrypoint route failed');
        msg.nak();
      }
    }
  }

  /**
   * Register a dispatch rule for a NATS subject.
   * Creates a durable JetStream consumer and starts an async pull loop.
   * Each message is routed to an instance picked by the configured strategy.
   * Idempotent: repeated calls for the same subject are no-ops.
   */
  async register(subject: string, config: DispatchConfig): Promise<void> {
    const key = `dispatch:${subject}`;
    if (this.activeLoops.has(key)) return;

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

    const signal = { aborted: false };
    const messagesRef: { current: ConsumerMessages | null } = { current: null };

    // Start async pull loop — restarts automatically on unexpected errors
    const done = this.runWithBackoff(
      () => this.pullLoop(consumer, subject, config, messagesRef),
      `dispatch:${subject}`,
      signal,
    );

    this.activeLoops.set(key, {
      stop: () => {
        signal.aborted = true;
        messagesRef.current?.close();
      },
      done,
      consumerName,
    });
  }

  private async pullLoop(
    consumer: Awaited<ReturnType<ReturnType<NatsConnection['jetstream']>['consumers']['get']>>,
    subject: string,
    config: DispatchConfig,
    messagesRef: { current: ConsumerMessages | null },
  ): Promise<void> {
    const messages = await consumer.consume({ max_messages: 1 });
    messagesRef.current = messages;

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
  }

  /**
   * Run an async loop function, restarting it with exponential backoff if it throws.
   * Max delay caps at 60s. Stops when NATS connection is closed or signal is aborted.
   */
  private async runWithBackoff(
    fn: () => Promise<void>,
    label: string,
    signal: { aborted: boolean },
  ): Promise<void> {
    let delay = 1000;
    while (!this.nc.isClosed() && !signal.aborted) {
      try {
        await fn();
        break; // clean exit (e.g. consumer drained) — do not restart
      } catch (err) {
        if (signal.aborted) break;
        logger.error({ err, label, retryInMs: delay }, 'WorkflowDispatcher: loop crashed — restarting');
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  /**
   * Stop the loop for a specific entrypoint route and remove its JetStream consumer.
   * After this call, registerEntrypointRoute() with the same key will re-create a fresh loop.
   */
  async unregisterEntrypointRoute(from: string, toSubject: string): Promise<void> {
    const key = `${from}=>${toSubject}`;
    const loop = this.activeLoops.get(key);
    if (!loop) return;

    loop.stop();
    await loop.done;
    this.activeLoops.delete(key);

    // Optionally delete the durable consumer from JetStream
    try {
      const jsm = await this.nc.jetstreamManager();
      await jsm.consumers.delete('AGENTS', loop.consumerName);
    } catch (err) {
      logger.warn({ err, key }, 'WorkflowDispatcher: failed to delete consumer on unregister');
    }

    logger.info({ from, toSubject }, 'WorkflowDispatcher: unregistered entrypoint route');
  }

  /**
   * Stop the loop for a specific dispatch rule and remove its JetStream consumer.
   * After this call, register() with the same subject will re-create a fresh loop.
   */
  async unregisterDispatch(subject: string): Promise<void> {
    const key = `dispatch:${subject}`;
    const loop = this.activeLoops.get(key);
    if (!loop) return;

    loop.stop();
    await loop.done;
    this.activeLoops.delete(key);

    try {
      const jsm = await this.nc.jetstreamManager();
      await jsm.consumers.delete('AGENTS', loop.consumerName);
    } catch (err) {
      logger.warn({ err, key }, 'WorkflowDispatcher: failed to delete consumer on unregister');
    }

    logger.info({ subject }, 'WorkflowDispatcher: unregistered dispatch rule');
  }

  /**
   * Stop all active loops cleanly (used for graceful shutdown).
   */
  async stopAll(): Promise<void> {
    const entries = [...this.activeLoops.entries()];
    for (const [, loop] of entries) loop.stop();
    await Promise.all(entries.map(([, loop]) => loop.done));
    this.activeLoops.clear();
    logger.info({ count: entries.length }, 'WorkflowDispatcher: stopped all loops');
  }

  /**
   * Returns the keys of all currently active loops (entrypoint routes + dispatch rules).
   * Key format: `${from}=>${toSubject}` for routes, `dispatch:${subject}` for dispatches.
   */
  get activeRouteKeys(): string[] {
    return [...this.activeLoops.keys()];
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
