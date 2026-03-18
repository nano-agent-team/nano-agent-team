/**
 * Deterministic test agent — no LLM.
 *
 * Reads messages from its JetStream consumer, publishes a receipt to test.received,
 * and sends heartbeats every 2s. Exits cleanly on drain signal.
 */

import { connect, StringCodec } from 'nats';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const AGENT_ID = process.env.AGENT_ID ?? 'unknown';
const CONSUMER_NAME = process.env.CONSUMER_NAME ?? AGENT_ID;
const SUBSCRIBE_TOPICS = (process.env.SUBSCRIBE_TOPICS ?? '').split(',').filter(Boolean);

const sc = StringCodec();

async function main() {
  console.log(JSON.stringify({ level: 'info', msg: 'Test agent starting', agentId: AGENT_ID, consumerName: CONSUMER_NAME, topics: SUBSCRIBE_TOPICS }));

  const nc = await connect({ servers: NATS_URL, name: `test-agent-${AGENT_ID}` });
  console.log(JSON.stringify({ level: 'info', msg: 'Connected to NATS', agentId: AGENT_ID }));

  // Publish ready signal
  nc.publish(`agent.${AGENT_ID}.ready`, sc.encode(JSON.stringify({ agentId: AGENT_ID, ts: Date.now() })));
  console.log(JSON.stringify({ level: 'info', msg: 'Ready signal published', agentId: AGENT_ID }));

  // Heartbeat every 2s
  let draining = false;
  const heartbeatTimer = setInterval(() => {
    try {
      nc.publish(`health.${AGENT_ID}`, sc.encode(JSON.stringify({
        agentId: AGENT_ID,
        ts: Date.now(),
        busy: false,
      })));
    } catch (err) {
      console.error(JSON.stringify({ level: 'warn', msg: 'Heartbeat failed', err: String(err) }));
      clearInterval(heartbeatTimer);
      process.exit(0);
    }
  }, 2000);

  // Drain signal subscription
  const drainSub = nc.subscribe(`agent.${AGENT_ID}.drain`);
  (async () => {
    for await (const _msg of drainSub) {
      console.log(JSON.stringify({ level: 'info', msg: 'Drain signal received', agentId: AGENT_ID }));
      draining = true;
      return;
    }
  })();

  // Hot-reload config subscription (no-op for test agent)
  const configSub = nc.subscribe(`agent.${AGENT_ID}.config`);
  (async () => {
    for await (const _msg of configSub) {
      // no-op
    }
  })();

  // JetStream consumer
  const js = nc.jetstream();
  let consumer;
  try {
    consumer = await js.consumers.get('AGENTS', CONSUMER_NAME);
    console.log(JSON.stringify({ level: 'info', msg: 'JetStream consumer acquired', agentId: AGENT_ID, consumerName: CONSUMER_NAME }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'Failed to get JetStream consumer', agentId: AGENT_ID, consumerName: CONSUMER_NAME, err: String(err) }));
    clearInterval(heartbeatTimer);
    await nc.drain();
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(JSON.stringify({ level: 'info', msg: 'Shutting down', signal, agentId: AGENT_ID }));
    clearInterval(heartbeatTimer);
    nc.drain().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Message consume loop
  console.log(JSON.stringify({ level: 'info', msg: 'Waiting for messages', agentId: AGENT_ID }));

  for await (const msg of await consumer.consume()) {
    const subject = msg.subject;
    let data = '';
    try {
      data = sc.decode(msg.data);
    } catch {
      data = '';
    }

    console.log(JSON.stringify({ level: 'info', msg: 'Message received', agentId: AGENT_ID, subject, data }));

    // Publish receipt to test.received
    const receipt = {
      instanceId: AGENT_ID,
      subject,
      data,
      ts: Date.now(),
    };
    nc.publish('test.received', sc.encode(JSON.stringify(receipt)));
    console.log(JSON.stringify({ level: 'info', msg: 'Receipt published', agentId: AGENT_ID, receipt }));

    msg.ack();

    if (draining) {
      console.log(JSON.stringify({ level: 'info', msg: 'Drained — exiting', agentId: AGENT_ID }));
      shutdown('drain');
      break;
    }
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'Fatal error', err: String(err) }));
  process.exit(1);
});
