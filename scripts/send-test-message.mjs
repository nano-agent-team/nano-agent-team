/**
 * Quick test: publish a message to agent.blank-agent.inbox and wait for reply
 * Usage: node scripts/send-test-message.mjs "Ahoj, co umíš?"
 */
import { connect, StringCodec } from 'nats';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const text = process.argv[2] ?? 'Ahoj, co umíš?';
const replySubject = `agent.blank-agent.reply.${Date.now()}`;

const nc = await connect({ servers: NATS_URL, name: 'test-sender' });
const js = nc.jetstream();
const codec = StringCodec();

// Subscribe to reply via JetStream (agent publishes reply to JetStream)
// Use ephemeral push consumer on a unique reply subject
const jsm = await js.jetstreamManager();
const consumerName = replySubject.replace(/\./g, '-');
await jsm.consumers.add('AGENTS', {
  name: consumerName,
  filter_subject: replySubject,
  ack_policy: 'explicit',
  deliver_policy: 'all',   // catch messages published before we start consuming
});
const consumer = await js.consumers.get('AGENTS', consumerName);

// Publish to JetStream AFTER consumer is registered (no missed messages)
const payload = JSON.stringify({ text, replySubject });
await js.publish('agent.blank-agent.inbox', codec.encode(payload));
console.log(`→ Sent: "${text}" (reply expected on ${replySubject})`);
console.log('   Waiting for reply (up to 60s)...');

const replyPromise = (async () => {
  for await (const msg of await consumer.consume({ max_messages: 1 })) {
    msg.ack();
    await jsm.consumers.delete('AGENTS', consumerName).catch(() => {});
    return JSON.parse(codec.decode(msg.data));
  }
})();

// Wait for reply (60s timeout — LLM calls can take ~10-30s)
const reply = await Promise.race([
  replyPromise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 60s')), 60000)),
]);

console.log('← Reply:', JSON.stringify(reply, null, 2));
await nc.drain();
