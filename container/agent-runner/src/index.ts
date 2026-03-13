/**
 * nano-agent-runner — runs inside the Docker container per agent
 *
 * Phase 3: Invokes Claude Agent SDK via query() for real LLM responses.
 * Supports stateless (new session per message) and persistent (remembered history) modes.
 *
 * Env vars (injected by AgentManager):
 *   NATS_URL          — NATS server URL
 *   AGENT_ID          — unique agent id (e.g. "blank-agent")
 *   SUBSCRIBE_TOPICS  — comma-separated NATS subjects
 *   ANTHROPIC_API_KEY — Anthropic key (read automatically by the SDK)
 *   MODEL             — Claude model id
 *   SESSION_TYPE      — "stateless" | "persistent" (default: stateless)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect, StringCodec } from 'nats';
import pino from 'pino';
import { query } from '@anthropic-ai/claude-agent-sdk';

// ─── Config ──────────────────────────────────────────────────────────────────

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const AGENT_ID = process.env.AGENT_ID ?? 'unknown';
const SUBSCRIBE_TOPICS = (process.env.SUBSCRIBE_TOPICS ?? '').split(',').filter(Boolean);
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001';
const SESSION_TYPE = (process.env.SESSION_TYPE ?? 'stateless') as 'stateless' | 'persistent';
const CLAUDE_MD_PATH = '/workspace/agent/CLAUDE.md';
const AGENT_SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT ?? '';
const SESSION_FILE = '/workspace/sessions/session_id';
const HEARTBEAT_INTERVAL_MS = 15_000;
const DB_PATH = process.env.DB_PATH ?? '/workspace/db/nano-agent-team.db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TICKETS_MCP_PATH = path.join(__dirname, 'tickets-mcp-stdio.js');

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = pino(
  { level: LOG_LEVEL },
  pino.transport({
    target: 'pino-pretty',
    options: { colorize: false, destination: 2 }, // stderr
  }),
);

// ─── Types ───────────────────────────────────────────────────────────────────

interface IncomingMessage {
  /** Direct text prompt (from send-test-message or direct inbox messages) */
  text?: string;
  /** Topic event payload (e.g. { ticket_id, title } from topic.ticket.new) */
  [key: string]: unknown;
  replySubject?: string;
}

interface ReplyPayload {
  agentId: string;
  result: string;
  error?: boolean;
  errorSubtype?: string;
  ts: number;
}

interface HeartbeatPayload {
  agentId: string;
  ts: number;
}

// ─── Session management ──────────────────────────────────────────────────────

function loadSessionId(): string | undefined {
  if (SESSION_TYPE !== 'persistent') return undefined;
  try {
    const id = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

function saveSessionId(id: string): void {
  if (SESSION_TYPE === 'persistent') {
    fs.writeFileSync(SESSION_FILE, id, 'utf8');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info(
    { agentId: AGENT_ID, natsUrl: NATS_URL, sessionType: SESSION_TYPE, model: MODEL },
    'Agent runner starting',
  );

  if (SUBSCRIBE_TOPICS.length === 0) {
    log.warn('SUBSCRIBE_TOPICS is empty — agent will not receive any messages');
  }

  // Write CLAUDE.md to /workspace/CLAUDE.md so Claude Code reads it automatically as cwd context.
  // Priority: AGENT_SYSTEM_PROMPT env var (injected by AgentManager) > file mount > fallback.
  const WORKSPACE_CLAUDE_MD = '/workspace/CLAUDE.md';
  const systemPromptContent = AGENT_SYSTEM_PROMPT || (fs.existsSync(CLAUDE_MD_PATH) ? fs.readFileSync(CLAUDE_MD_PATH, 'utf8') : '');
  if (systemPromptContent) {
    fs.writeFileSync(WORKSPACE_CLAUDE_MD, systemPromptContent, 'utf8');
    log.info({ agentId: AGENT_ID, source: AGENT_SYSTEM_PROMPT ? 'env' : 'file' }, 'CLAUDE.md written to workspace cwd');
  } else {
    fs.writeFileSync(
      WORKSPACE_CLAUDE_MD,
      `# ${AGENT_ID}\n\nYou are ${AGENT_ID}, a helpful AI agent.\n`,
      'utf8',
    );
    log.warn({ agentId: AGENT_ID }, 'No CLAUDE.md found — wrote minimal fallback');
  }

  // Connect to NATS
  const nc = await connect({ servers: NATS_URL, name: `agent-${AGENT_ID}` });
  const codec = StringCodec();

  log.info({ url: NATS_URL }, 'Connected to NATS');

  // ── Heartbeat (core NATS, not JetStream) ─────────────────────────────────
  const heartbeatTimer = setInterval(() => {
    const payload: HeartbeatPayload = { agentId: AGENT_ID, ts: Date.now() };
    nc.publish(`health.${AGENT_ID}`, codec.encode(JSON.stringify(payload)));
    log.debug({ agentId: AGENT_ID }, 'Heartbeat sent');
  }, HEARTBEAT_INTERVAL_MS);

  // ── JetStream consumer pull loop ─────────────────────────────────────────
  const js = nc.jetstream();

  let consumer;
  try {
    consumer = await js.consumers.get('AGENTS', AGENT_ID);
  } catch (err) {
    log.error({ err, agentId: AGENT_ID }, 'Failed to get JetStream consumer — is it created?');
    clearInterval(heartbeatTimer);
    await nc.drain();
    process.exit(1);
  }

  log.info(
    { agentId: AGENT_ID, topics: SUBSCRIBE_TOPICS },
    'Agent runner ready — waiting for messages',
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'Shutting down agent runner');
    clearInterval(heartbeatTimer);
    await nc.drain();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Message processing loop
  for await (const msg of await consumer.consume()) {
    const subject = msg.subject;
    let payload: IncomingMessage;

    try {
      payload = JSON.parse(codec.decode(msg.data)) as IncomingMessage;
    } catch {
      log.warn({ subject }, 'Received non-JSON message — skipping');
      msg.ack();
      continue;
    }

    // Build prompt: prepend agent role context from CLAUDE.md, then the actual message
    // Priority: AGENT_SYSTEM_PROMPT env var > file mount
    const claudeMdContent = AGENT_SYSTEM_PROMPT || (fs.existsSync(CLAUDE_MD_PATH) ? fs.readFileSync(CLAUDE_MD_PATH, 'utf8') : '');

    // For chat agents: use only the text field. For event agents without text: include full payload.
    const eventContext = payload.text
      ? String(payload.text)
      : `Event on topic "${subject}":\n\n${JSON.stringify(payload, null, 2)}`;

    // Combine: role instructions (system prompt) + user message
    const prompt: string = claudeMdContent
      ? `${claudeMdContent}\n\n---\n\n${eventContext}`
      : eventContext;

    log.info({ agentId: AGENT_ID, subject, promptLen: prompt.length }, 'Message received');

    // ── Phase 3: Claude Agent SDK invocation ─────────────────────────────
    const existingSessionId = loadSessionId();

    const options: Record<string, unknown> = {
      model: MODEL,
      cwd: '/workspace',  // CLAUDE.md is read from here automatically by Claude Code
      permissionMode: 'acceptEdits',
      // Built-in tools + MCP ticket tools
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'mcp__tickets__*'],
      maxTurns: 50,
      // Tickets MCP server — provides ticket CRUD tools natively
      mcpServers: {
        tickets: {
          command: 'node',
          args: [TICKETS_MCP_PATH],
          env: {
            DB_PATH,
            AGENT_ID,
          },
        },
      },
    };

    if (SESSION_TYPE === 'persistent' && existingSessionId) {
      options.resume = existingSessionId;
    }

    log.debug(
      { agentId: AGENT_ID, sessionType: SESSION_TYPE, hasSession: !!existingSessionId },
      'Invoking query()',
    );

    let result = '';
    let sessionId: string | undefined;
    let errorSubtype: string | undefined;

    try {
      const q = query({ prompt, options });

      for await (const sdkMsg of q) {
        // Capture session id from any message that carries it
        if (!sessionId && sdkMsg && typeof sdkMsg === 'object' && 'session_id' in sdkMsg) {
          sessionId = (sdkMsg as { session_id: string }).session_id;
        }

        if (sdkMsg.type === 'result') {
          if (sdkMsg.subtype === 'success') {
            result = sdkMsg.result ?? '';
            log.debug({ agentId: AGENT_ID, resultLength: result.length }, 'query() succeeded');
          } else {
            errorSubtype = sdkMsg.subtype;
            result = `[Error: ${sdkMsg.subtype}]`;
            log.warn({ agentId: AGENT_ID, subtype: sdkMsg.subtype }, 'query() returned error');
          }
          break;
        }
      }
    } catch (err) {
      log.error({ err, agentId: AGENT_ID }, 'query() threw an exception');
      result = `[Error: ${err instanceof Error ? err.message : String(err)}]`;
      errorSubtype = 'exception';
    }

    if (sessionId) {
      saveSessionId(sessionId);
      log.debug({ agentId: AGENT_ID, sessionId }, 'Session id saved');
    }

    // ── Publish reply ─────────────────────────────────────────────────────
    const replySubject = payload.replySubject ?? `agent.${AGENT_ID}.reply`;
    const reply: ReplyPayload = {
      agentId: AGENT_ID,
      result,
      ...(errorSubtype ? { error: true, errorSubtype } : {}),
      ts: Date.now(),
    };

    try {
      // Use core NATS publish for replies — reply subjects (chat.reply.*)
      // are not in the JetStream stream, so js.publish would timeout.
      nc.publish(replySubject, codec.encode(JSON.stringify(reply)));
      log.info(
        { agentId: AGENT_ID, replySubject, resultLength: result.length },
        'Reply sent',
      );
    } catch (err) {
      log.error({ err, replySubject }, 'Failed to publish reply');
    }

    msg.ack();
  }
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal agent runner error');
  process.exit(1);
});
