/**
 * nano-agent-runner — runs inside the Docker container per agent
 *
 * Phase 3: Invokes LLM via configurable provider (Claude, Codex, Gemini, etc).
 * Supports stateless (new session per message) and persistent (remembered history) modes.
 *
 * Env vars (injected by AgentManager):
 *   NATS_URL          — NATS server URL
 *   AGENT_ID          — unique agent id (e.g. "blank-agent")
 *   SUBSCRIBE_TOPICS  — comma-separated NATS subjects
 *   PROVIDER          — LLM provider name (default: "claude")
 *   MODEL             — Model id for the provider
 *   SESSION_TYPE      — "stateless" | "persistent" (default: stateless)
 *   WAIT_FOR_START_SIGNAL — if "true", wait for agent.{id}.start-consuming before pulling
 *   EPHEMERAL_TASK_MESSAGE — base64-encoded JSON task; if set, process once and exit (no NATS)
 *   ANTHROPIC_API_KEY / CODEX_OAUTH_TOKEN / GEMINI_API_KEY — provider-specific auth
 *   OBSERVABILITY_LEVEL          — "none" | "logging" | "full"
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — OTLP HTTP endpoint
 */

// OTel SDK must be initialized BEFORE any other imports
import './tracing/init.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect, StringCodec, headers as natsHeaders } from 'nats';
import type { Consumer } from 'nats';
import type { McpServerConfig } from './providers/types.js';
import pino from 'pino';
import { isTracingEnabled } from './tracing/init.js';
import { extractTraceContext, startSpan, startChildSpan, injectTraceContext } from './tracing/nats-context.js';
import { createProvider } from './providers/index.js';
import type { Provider } from './providers/index.js';

// ─── Version ─────────────────────────────────────────────────────────────────

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version: RUNNER_VERSION } = require('../package.json') as { version: string };

if (process.argv.includes('--version')) {
  console.log(RUNNER_VERSION);
  process.exit(0);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const AGENT_ID = process.env.AGENT_ID ?? 'unknown';
const CONSUMER_NAME = process.env.CONSUMER_NAME ?? AGENT_ID;
const SUBSCRIBE_TOPICS = (process.env.SUBSCRIBE_TOPICS ?? '').split(',').filter(Boolean);
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const PROVIDER_NAME = process.env.PROVIDER ?? 'claude';
// Mutable for hot-reload (Phase 4)
let MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001';
const MODEL_EXPLICIT = process.env.MODEL_EXPLICIT === 'true';
// 'stateful' is an alias for 'persistent' (manifest uses 'stateful', runner uses 'persistent')
const SESSION_TYPE = (() => {
  const raw = process.env.SESSION_TYPE ?? 'stateless';
  return raw === 'stateful' ? 'persistent' : raw;
})() as 'stateless' | 'persistent';
/** If true, wait for agent.{id}.start-consuming before pulling (Phase 5 rollover) */
const WAIT_FOR_START_SIGNAL = process.env.WAIT_FOR_START_SIGNAL === 'true';
const CLAUDE_MD_PATH = '/workspace/agent/CLAUDE.md';
const AGENT_SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT ?? '';
const AGENT_ALLOWED_TOOLS = (process.env.AGENT_ALLOWED_TOOLS ?? '').split(',').filter(Boolean);
const SESSION_FILE = '/workspace/sessions/session_id';
const HEARTBEAT_INTERVAL_MS = 15_000;
const DB_PATH = process.env.DB_PATH ?? '/workspace/db/nano-agent-team.db';

// MCP Gateway — HTTP server running in nate, accessible from DinD via host.docker.internal
// Falls back to stdio MCP if gateway URL is not provided
const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? '';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TICKETS_MCP_PATH = path.join(__dirname, 'tickets-mcp-stdio.js');

/** MCP server config passed to provider.run() — HTTP gateway if available, stdio fallback */
const ticketsMcpServer = MCP_GATEWAY_URL
  ? { type: 'http' as const, url: MCP_GATEWAY_URL, headers: { 'x-agent-id': AGENT_ID } }
  : { command: 'node', args: [TICKETS_MCP_PATH], env: { DB_PATH, AGENT_ID } };

/** Extra MCP servers injected from the agent manifest's mcp_config field */
const agentMcpServers: Record<string, unknown> = (() => {
  const raw = process.env.AGENT_MCP_SERVERS;
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
})();

/** Soul MCP server — same gateway, separate namespace for consciousness layer tools */
const soulMcpServer = MCP_GATEWAY_URL
  ? { type: 'http' as const, url: MCP_GATEWAY_URL, headers: { 'x-agent-id': AGENT_ID } }
  : undefined;

/** All MCP servers: tickets + soul + context-mode (opt-in) + any agent-specific servers */
const allMcpServers: Record<string, McpServerConfig> = {
  tickets: ticketsMcpServer,
  ...(soulMcpServer ? { soul: soulMcpServer } : {}),
  ...(agentMcpServers as Record<string, McpServerConfig>),
  ...(process.env.CONTEXT_MODE === 'true'
    ? { 'context-mode': { command: 'context-mode', args: [] } }
    : {}),
};

// ─── Output Validation ───────────────────────────────────────────────────────

// Output validation: check if agent has declared outputs in manifest
let outputValidationEnabled = false;
try {
  const manifestPath = '/workspace/agent/manifest.json';
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const hasOutputs = Array.isArray(manifest.outputs) && manifest.outputs.some((o: { subject?: string }) => !!o.subject);
    if (!hasOutputs && Array.isArray(manifest.publish_topics) && manifest.publish_topics.length > 0) {
      outputValidationEnabled = true; // legacy format
    } else {
      outputValidationEnabled = hasOutputs;
    }
  }
} catch {
  // Failed to read manifest for output validation — disable silently
}

// ─── Logger ──────────────────────────────────────────────────────────────────

/** OTel trace correlation mixin — adds traceId/spanId to every log line */
function otelMixin(): Record<string, unknown> {
  try {
    const api = (globalThis as Record<string, unknown>).__otelApi as typeof import('@opentelemetry/api') | undefined;
    if (!api) return {};
    const span = api.trace.getActiveSpan();
    if (!span) return {};
    const ctx = span.spanContext();
    if (!ctx || !api.isSpanContextValid(ctx)) return {};
    return { traceId: ctx.traceId, spanId: ctx.spanId };
  } catch {
    return {};
  }
}

const log = pino(
  { level: LOG_LEVEL, mixin: otelMixin },
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
  /** If set, text tokens are streamed to this subject as they arrive from the LLM */
  streamSubject?: string;
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
  busy?: boolean;
  task?: string;
  ticketId?: string;
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

/** First message of this container lifecycle always starts a fresh session.
 *  This prevents stale session IDs (from a previous container run) from
 *  causing the provider to hang on resume. */
let firstMessageOfLifecycle = true;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info(
    { agentId: AGENT_ID, version: RUNNER_VERSION, provider: PROVIDER_NAME, model: MODEL, natsUrl: NATS_URL, sessionType: SESSION_TYPE, waitForStart: WAIT_FOR_START_SIGNAL },
    'Agent runner starting',
  );

  if (outputValidationEnabled) {
    log.info({ agentId: AGENT_ID }, 'Output validation enabled — will check for publish_signal calls');
  }

  if (SUBSCRIBE_TOPICS.length === 0) {
    log.warn('SUBSCRIBE_TOPICS is empty — agent will not receive any messages');
  }

  // Create provider instance
  let provider: Provider;
  try {
    provider = createProvider(PROVIDER_NAME);
    log.info({ provider: PROVIDER_NAME }, 'Provider created');
  } catch (err) {
    log.error({ err, provider: PROVIDER_NAME }, 'Failed to create provider');
    process.exit(1);
  }

  // Write system prompt via provider
  const systemPromptContent = AGENT_SYSTEM_PROMPT || (fs.existsSync(CLAUDE_MD_PATH) ? fs.readFileSync(CLAUDE_MD_PATH, 'utf8') : '');
  let systemPrompt = systemPromptContent || `# ${AGENT_ID}\n\nYou are ${AGENT_ID}, a helpful AI agent.\n`;

  try {
    provider.writeSystemPrompt('/workspace', systemPrompt);
    log.info({ provider: PROVIDER_NAME, source: AGENT_SYSTEM_PROMPT ? 'env' : 'file' }, 'System prompt written via provider');
  } catch (err) {
    log.error({ err, provider: PROVIDER_NAME }, 'Failed to write system prompt');
    process.exit(1);
  }

  // ── Ephemeral mode: process a single task from env var, then exit ─────────
  const ephemeralTaskB64 = process.env.EPHEMERAL_TASK_MESSAGE;
  if (ephemeralTaskB64) {
    log.info({ agentId: AGENT_ID }, 'Ephemeral mode: processing single task from EPHEMERAL_TASK_MESSAGE');

    let payload: IncomingMessage;
    try {
      const decoded = Buffer.from(ephemeralTaskB64, 'base64').toString('utf8');
      payload = JSON.parse(decoded) as IncomingMessage;
    } catch (err) {
      log.error({ err }, 'Failed to decode EPHEMERAL_TASK_MESSAGE');
      process.exit(1);
    }

    const claudeMdContent = systemPrompt || '';
    const ghToken = (payload as Record<string, unknown>).gh_token as string | undefined;
    const payloadForPrompt = ghToken
      ? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([k]) => k !== 'gh_token'))
      : payload;

    const eventContext = payloadForPrompt.text
      ? String(payloadForPrompt.text)
      : `Event:\n\n${JSON.stringify(payloadForPrompt, null, 2)}`;

    const prompt: string = eventContext;

    log.info({ agentId: AGENT_ID, promptLen: prompt.length }, 'Ephemeral task decoded — invoking provider');

    let result = '';
    let errorSubtype: string | undefined;

    try {
      const providerRun = provider.run({
        model: MODEL,
        modelExplicit: MODEL_EXPLICIT,
        cwd: '/workspace',
        prompt,
        maxTurns: 0, // unlimited — watchdog agent will handle stuck loops in the future
        systemPrompt: claudeMdContent || undefined,
        ...(ghToken ? { extraEnv: { GH_TOKEN: ghToken } } : {}),
        ...(AGENT_ALLOWED_TOOLS.length > 0 ? { allowedTools: AGENT_ALLOWED_TOOLS } : {}),
        mcpServers: allMcpServers,
      });

      for await (const event of providerRun) {
        if (event.type === 'result') {
          result = event.result;
          errorSubtype = event.errorSubtype;
        }
      }
    } catch (err) {
      log.error({ err, agentId: AGENT_ID, provider: PROVIDER_NAME }, 'Provider threw an exception in ephemeral mode');
      result = `[Error: ${err instanceof Error ? err.message : String(err)}]`;
      errorSubtype = 'exception';
    }

    if (errorSubtype) {
      log.warn({ agentId: AGENT_ID, errorSubtype, resultLength: result.length }, 'Ephemeral task completed with error');
    } else {
      log.info({ agentId: AGENT_ID, resultLength: result.length }, 'Ephemeral task completed successfully');
    }

    // Write result to a well-known file so the control plane can read it
    try {
      fs.mkdirSync('/workspace/output', { recursive: true });
      fs.writeFileSync('/workspace/output/result.json', JSON.stringify({
        agentId: AGENT_ID,
        result,
        ...(errorSubtype ? { error: true, errorSubtype } : {}),
        ts: Date.now(),
      }), 'utf8');
    } catch (err) {
      log.warn({ err }, 'Failed to write ephemeral result file');
    }

    // ── After-work hook: set ticket to done (deterministic handoff) ──────
    // Only on success — failed agents leave ticket in_progress for orphan detection
    const ephemeralTicketId = process.env.EPHEMERAL_TICKET_ID;
    if (!errorSubtype && ephemeralTicketId) {
      try {
        const apiUrl = MCP_GATEWAY_URL.replace('/mcp', '') || 'http://host.docker.internal:3001';
        const resp = await fetch(`${apiUrl}/api/tickets/${encodeURIComponent(ephemeralTicketId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done', expected_status: 'in_progress', changed_by: AGENT_ID }),
        });
        if (resp.ok) {
          log.info({ ticketId: ephemeralTicketId }, 'After-work: ticket set to done');
        } else {
          log.warn({ ticketId: ephemeralTicketId, status: resp.status }, 'After-work: failed to set done');
        }
      } catch (err) {
        log.warn({ err, ticketId: ephemeralTicketId }, 'After-work: error (non-fatal)');
      }
    }

    process.exit(errorSubtype ? 1 : 0);
  }

  // Connect to NATS
  const nc = await connect({ servers: NATS_URL, name: `agent-${AGENT_ID}` });
  const codec = StringCodec();

  log.info({ url: NATS_URL }, 'Connected to NATS');

  // ── Heartbeat (core NATS, not JetStream) ─────────────────────────────────
  let baseTask = '';
  let currentTask = '';
  let isBusy = false;
  let currentTicketId: string | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval>;

  function publishHeartbeat() {
    const payload: HeartbeatPayload = {
      agentId: AGENT_ID, ts: Date.now(),
      busy: isBusy,
      ...(currentTask ? { task: currentTask } : {}),
      ...(currentTicketId ? { ticketId: currentTicketId } : {}),
    };
    try {
      nc.publish(`health.${AGENT_ID}`, codec.encode(JSON.stringify(payload)));
    } catch (err) {
      log.warn({ err }, 'Heartbeat publish failed — NATS connection lost, exiting');
      clearInterval(heartbeatTimer);
      process.exit(0);
    }
  }

  /** Maps a provider tool name to a short human-readable activity description. */
  function toolActivity(toolName: string): string {
    const mcpMatch = toolName.match(/^mcp__(\w+)__(.+)$/);
    if (mcpMatch) {
      const op = mcpMatch[2].replace(/_/g, ' ');
      return `${mcpMatch[1]}: ${op}`;
    }
    const map: Record<string, string> = {
      Bash: 'running command',
      Read: 'reading file',
      Write: 'writing file',
      Edit: 'editing file',
      Glob: 'searching files',
      Grep: 'searching code',
      WebFetch: 'fetching URL',
      WebSearch: 'web search',
      TodoWrite: 'updating todos',
      TodoRead: 'reading todos',
    };
    return map[toolName] ?? toolName;
  }

  heartbeatTimer = setInterval(() => {
    publishHeartbeat();
    log.debug({ agentId: AGENT_ID }, 'Heartbeat sent');
  }, HEARTBEAT_INTERVAL_MS);

  // ── Phase 4: Hot-reload config subscription ───────────────────────────────
  // Subscribes to agent.{id}.config (core NATS, not JetStream) for live updates.
  // model and systemPrompt changes take effect on the next message processed.
  const configSub = nc.subscribe(`agent.${AGENT_ID}.config`);
  void (async () => {
    for await (const msg of configSub) {
      try {
        const update = JSON.parse(codec.decode(msg.data)) as { model?: string; systemPrompt?: string };
        if (update.model) {
          MODEL = update.model;
          log.info({ agentId: AGENT_ID, model: update.model }, 'Hot-reload: model updated');
        }
        if (update.systemPrompt !== undefined) {
          systemPrompt = update.systemPrompt;
          try { provider.writeSystemPrompt('/workspace', update.systemPrompt); } catch { /* ignore */ }
          log.info({ agentId: AGENT_ID }, 'Hot-reload: system prompt updated');
        }
      } catch { /* ignore malformed config messages */ }
    }
  })();

  // ── Phase 5: Drain signal subscription ───────────────────────────────────
  // Drain: finish current message, then exit gracefully (for zero-downtime rollover).
  let draining = false;
  const drainSub = nc.subscribe(`agent.${AGENT_ID}.drain`);
  void (async () => {
    for await (const _msg of drainSub) {
      log.info({ agentId: AGENT_ID }, 'Drain signal received — will exit after current message');
      draining = true;
      return; // only need to receive once
    }
  })();

  // ── JetStream consumer pull loop ─────────────────────────────────────────
  const js = nc.jetstream();

  let consumer: Consumer;
  try {
    consumer = await js.consumers.get('AGENTS', CONSUMER_NAME);
  } catch (err) {
    log.error({ err, agentId: AGENT_ID, consumerName: CONSUMER_NAME }, 'Failed to get JetStream consumer — is it created?');
    clearInterval(heartbeatTimer);
    await nc.drain();
    process.exit(1);
  }

  // Track current session for graceful shutdown
  let currentSessionId: string | undefined;

  // Graceful shutdown — save session synchronously so it survives SIGKILL
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal, hasSession: !!currentSessionId }, 'Shutting down agent runner');
    if (currentSessionId) {
      try {
        fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
        fs.writeFileSync(SESSION_FILE, currentSessionId, 'utf8');
        log.info({ agentId: AGENT_ID, sessionId: currentSessionId }, 'Session saved for resume after restart');
      } catch (err) {
        log.error({ err }, 'Failed to save session on shutdown');
      }
    }
    clearInterval(heartbeatTimer);
    nc.drain().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── Publish ready signal (Phase 5) ────────────────────────────────────────
  // Signals AgentManager that this container is initialized and ready.
  // In rollover mode, AgentManager waits for this before draining the old container.
  nc.publish(`agent.${AGENT_ID}.ready`, codec.encode(JSON.stringify({ agentId: AGENT_ID, ts: Date.now() })));
  log.info({ agentId: AGENT_ID }, 'Ready signal published');

  // ── Load saved session ID on startup ─────────────────────────────────────
  // For persistent agents: restore the session ID so the first message continues
  // the previous conversation. We do NOT run a resume query on startup — that
  // caused confused state and phantom responses. The saved session ID will be
  // picked up by loadSessionId() when the first message arrives.
  {
    const saved = loadSessionId();
    if (saved) {
      log.info({ agentId: AGENT_ID, sessionId: saved }, 'Found saved session ID — will be used after first fresh message');
    }
  }

  log.info(
    { agentId: AGENT_ID, topics: SUBSCRIBE_TOPICS },
    'Agent runner ready — waiting for messages',
  );

  // ── Phase 5: Wait for start-consuming signal in rollover mode ─────────────
  if (WAIT_FOR_START_SIGNAL) {
    log.info({ agentId: AGENT_ID }, 'Rollover mode: waiting for start-consuming signal');
    const signalReceived = await Promise.race([
      new Promise<boolean>((resolve) => {
        const startSub = nc.subscribe(`agent.${AGENT_ID}.start-consuming`, { max: 1 });
        void (async () => {
          for await (const _msg of startSub) {
            log.info({ agentId: AGENT_ID }, 'Start-consuming signal received — beginning consume loop');
            resolve(true);
            return;
          }
        })();
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60_000)),
    ]);

    if (!signalReceived) {
      // AgentManager may have crashed between steps 1 and 5 — start consuming anyway to avoid permanent hang.
      log.warn({ agentId: AGENT_ID }, 'start-consuming timeout (60s) — starting consume loop without signal');
    }
  }

  // ── Message processing loop ───────────────────────────────────────────────

  async function startConsumeLoop(): Promise<void> {
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

      // ── Mark agent as busy ──────────────────────────────────────────────
      const ticketId = (payload as Record<string, unknown>).ticket_id as string | undefined;
      const ticketTitle = ((payload as Record<string, unknown>).ticket as Record<string, unknown>)?.title as string | undefined
        ?? (payload as Record<string, unknown>).title as string | undefined;
      const chatText = (payload as Record<string, unknown>).text as string | undefined;

      currentTicketId = ticketId;
      if (ticketId) {
        baseTask = ticketTitle ? `${ticketId}: ${ticketTitle}` : ticketId;
      } else if (chatText) {
        baseTask = chatText.length > 60 ? chatText.slice(0, 57) + '...' : chatText;
      } else {
        baseTask = subject.replace('agent.', '').replace('.inbox', '');
      }
      currentTask = baseTask;
      isBusy = true;
      publishHeartbeat();

      // ── Extract trace context from NATS headers ─────────────────────────
      const headerAdapter = msg.headers ? {
        get: (key: string) => msg.headers?.get(key),
        set: (key: string, value: string) => { /* read-only for extraction */ },
      } : undefined;
      const traceCtx = headerAdapter ? extractTraceContext(headerAdapter) : null;

      const shortSubject = subject.replace('agent.', '').replace('.inbox', '');
      const spanLabel = ticketId
        ? `${AGENT_ID}: ${shortSubject} ${ticketId}`
        : `${AGENT_ID}: ${shortSubject}`;

      const spanAttrs: Record<string, string> = { 'agent.id': AGENT_ID, 'nats.subject': subject };
      if (ticketId) spanAttrs['ticket.id'] = ticketId;
      if (ticketTitle) spanAttrs['ticket.title'] = ticketTitle;

      const processSpan = startSpan(spanLabel, traceCtx, spanAttrs);

      // Build prompt using the current (possibly hot-reloaded) system prompt
      // Use ?? so that an empty string from hot-reload clears the prompt (not falls back to previous)
      const claudeMdContent = systemPrompt ?? AGENT_SYSTEM_PROMPT ?? (fs.existsSync(CLAUDE_MD_PATH) ? fs.readFileSync(CLAUDE_MD_PATH, 'utf8') : '');

      const ghToken = (payload as Record<string, unknown>).gh_token as string | undefined;
      const payloadForPrompt = ghToken
        ? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([k]) => k !== 'gh_token'))
        : payload;

      const eventContext = payloadForPrompt.text
        ? String(payloadForPrompt.text)
        : `Event on topic "${subject}":\n\n${JSON.stringify(payloadForPrompt, null, 2)}`;

      // ── Output validation: reset per-message tracking ─────────────────────
      let publishSignalCalled = false;
      let lastThinkingEmit = 0;

      // ── Provider invocation ───────────────────────────────────────────────
      const existingSessionId = firstMessageOfLifecycle ? undefined : loadSessionId();

      // CLAUDE.md is written to /workspace/CLAUDE.md at startup and read automatically by Claude Code.
      // Never prepend it to the prompt — it would re-inject instructions as a user message,
      // breaking session continuity on resumed turns.
      const prompt: string = eventContext;

      log.info({ agentId: AGENT_ID, subject, promptLen: prompt.length, resuming: !!existingSessionId }, 'Message received');

      log.debug(
        { agentId: AGENT_ID, provider: PROVIDER_NAME, sessionType: SESSION_TYPE, hasSession: !!existingSessionId },
        'Invoking provider.run()',
      );

      // Use current MODEL (may have been hot-reloaded)
      const querySpan = processSpan
        ? startChildSpan(`${PROVIDER_NAME}.query`, processSpan.context, { 'provider.model': MODEL })
        : null;

      let result = '';
      let sessionId: string | undefined;
      let errorSubtype: string | undefined;
      const streamSubject = (payload as Record<string, unknown>).streamSubject as string | undefined;

      const workingTimer = setInterval(() => {
        try { msg.working(); } catch { /* ignore if msg already acked */ }
      }, 30_000);

      try {
        const providerRun = provider.run({
          model: MODEL,
          modelExplicit: MODEL_EXPLICIT,
          cwd: '/workspace',
          prompt,
          sessionId: existingSessionId,
          maxTurns: 0, // unlimited — watchdog agent will handle stuck loops in the future
          systemPrompt: claudeMdContent || undefined,
          ...(ghToken ? { extraEnv: { GH_TOKEN: ghToken } } : {}),
          ...(AGENT_ALLOWED_TOOLS.length > 0 ? { allowedTools: AGENT_ALLOWED_TOOLS } : {}),
          mcpServers: allMcpServers,
        });

        for await (const event of providerRun) {
          if (event.type === 'session_id') {
            sessionId = event.sessionId;
            currentSessionId = sessionId;
          } else if (event.type === 'text') {
            if (streamSubject) {
              nc.publish(streamSubject, codec.encode(JSON.stringify({ type: 'chunk', text: event.text })));
            }
            // Debounced thinking activity for per-agent SSE stream
            if (Date.now() - lastThinkingEmit > 5000) {
              lastThinkingEmit = Date.now();
              try {
                nc.publish(`activity.${AGENT_ID}`, codec.encode(JSON.stringify({
                  type: 'thinking',
                  summary: 'Thinking...',
                  preview: event.text.substring(0, 100),
                  timestamp: Date.now(),
                })));
              } catch { /* ignore */ }
            }
          } else if (event.type === 'tool_call') {
            currentTask = baseTask ? `${baseTask} → ${toolActivity(event.toolName)}` : toolActivity(event.toolName);
            publishHeartbeat();
            if (streamSubject) {
              nc.publish(streamSubject, codec.encode(JSON.stringify({ type: 'tool_call', toolName: event.toolName })));
            }
            if (querySpan) {
              querySpan.span.addEvent('tool_call', { 'tool.name': event.toolName });
            }
            // Output validation: track publish_signal calls
            // MCP tools have namespaced names: mcp__soul__publish_signal
            const bareName = event.toolName.replace(/^mcp__soul__/, '');
            log.info({ agentId: AGENT_ID, toolName: event.toolName, bareName }, 'Tool call detected');
            if (bareName === 'publish_signal') {
              publishSignalCalled = true;
            }
            // Publish activity event for per-agent SSE stream
            try {
              nc.publish(`activity.${AGENT_ID}`, codec.encode(JSON.stringify({
                type: 'tool_call',
                summary: toolActivity(event.toolName),
                toolName: event.toolName,
                timestamp: Date.now(),
              })));
            } catch { /* ignore activity publish failure */ }
          } else if (event.type === 'result') {
            result = event.result;
            errorSubtype = event.errorSubtype;
            if (!event.success) {
              log.warn({ agentId: AGENT_ID, provider: PROVIDER_NAME, subtype: errorSubtype }, 'Provider returned error');
              if (querySpan) querySpan.span.setAttribute(`${PROVIDER_NAME}.error`, errorSubtype ?? 'unknown');
            } else {
              log.debug({ agentId: AGENT_ID, provider: PROVIDER_NAME, resultLength: result.length }, 'Provider succeeded');
              if (querySpan) querySpan.span.setAttribute(`${PROVIDER_NAME}.result_length`, result.length);
            }
          }
        }
      } catch (err) {
        log.error({ err, agentId: AGENT_ID, provider: PROVIDER_NAME }, 'Provider threw an exception');
        result = `[Error: ${err instanceof Error ? err.message : String(err)}]`;
        errorSubtype = 'exception';
        if (querySpan) querySpan.span.setAttribute(`${PROVIDER_NAME}.error`, 'exception');
      } finally {
        clearInterval(workingTimer);
      }

      querySpan?.end();

      if (sessionId) {
        saveSessionId(sessionId);
        log.debug({ agentId: AGENT_ID, sessionId }, 'Session id saved');
      }
      if (firstMessageOfLifecycle) {
        firstMessageOfLifecycle = false;
        if (!sessionId) {
          // First message failed without producing a session — clear stale file
          try { fs.unlinkSync(path.join('/workspace/sessions', 'session_id')); } catch { /* ignore */ }
          log.warn({ agentId: AGENT_ID }, 'First message failed without session — cleared stale session file');
        } else {
          log.info({ agentId: AGENT_ID }, 'First message completed — subsequent messages will resume session');
        }
      }
      // Capture session ID for potential output-validation retry before cleanup
      const retrySessionId = currentSessionId;
      currentSessionId = undefined;

      // ── Signal stream end ─────────────────────────────────────────────────
      if (streamSubject) {
        const doneEvent = errorSubtype
          ? { type: 'error', error: result }
          : { type: 'done' };
        nc.publish(streamSubject, codec.encode(JSON.stringify(doneEvent)));
      }

      // ── Publish reply ─────────────────────────────────────────────────────
      const replySubject = payload.replySubject ?? `agent.${AGENT_ID}.reply`;
      const reply: ReplyPayload = {
        agentId: AGENT_ID,
        result,
        ...(errorSubtype ? { error: true, errorSubtype } : {}),
        ts: Date.now(),
      };

      const replySpan = processSpan
        ? startChildSpan('nats.publish', processSpan.context, { 'nats.subject': replySubject })
        : null;

      try {
        const replyHdrs = natsHeaders();
        const replyHeaderAdapter = {
          get: (key: string) => replyHdrs.get(key),
          set: (key: string, value: string) => replyHdrs.set(key, value),
        };
        if (processSpan) {
          injectTraceContext(replyHeaderAdapter, traceCtx?.sessionId);
        }

        nc.publish(replySubject, codec.encode(JSON.stringify(reply)), { headers: replyHdrs });
        log.info(
          { agentId: AGENT_ID, replySubject, resultLength: result.length },
          'Reply sent',
        );
      } catch (err) {
        log.error({ err, replySubject }, 'Failed to publish reply');
      }

      replySpan?.end();
      processSpan?.end();

      // Mark agent as idle
      isBusy = false;
      baseTask = '';
      currentTask = '';
      currentTicketId = undefined;
      publishHeartbeat();

      // ── Output validation: retry if publish_signal was not called ────────
      if (!outputValidationEnabled || publishSignalCalled) {
        msg.ack();
      } else {
        log.warn({ agentId: AGENT_ID, resultPreview: result.substring(0, 500) }, 'No publish_signal called — retrying once');
        const retryWorking = setInterval(() => { try { msg.working(); } catch {} }, 30_000);
        try {
          for await (const ev of provider.run({
            model: MODEL, cwd: '/workspace',
            prompt: 'You processed a message but did not call publish_signal. Every input must produce an output. Use publish_signal to send your result to the next agent.',
            sessionId: retrySessionId, maxTurns: 1,
            mcpServers: allMcpServers,
          })) {
            if (ev.type === 'tool_call') {
              const bn = ev.toolName.replace(/^mcp__soul__/, '');
              if (bn === 'publish_signal') publishSignalCalled = true;
            }
          }
        } catch (err) { log.error({ err }, 'Output retry failed'); }
        clearInterval(retryWorking);
        msg.ack();
        if (!publishSignalCalled) {
          log.error({ agentId: AGENT_ID }, 'Agent swallowed message — no publish_signal after retry');
          // Fallback: publish pipeline.task.failed so dispatcher knows the task didn't complete properly
          try {
            const failPayload = JSON.stringify({
              agentId: AGENT_ID,
              reason: 'Agent completed work but did not call publish_signal — likely missing mcp_permissions.soul',
              resultPreview: result.substring(0, 300),
              subject,
              ts: Date.now(),
            });
            nc.publish('pipeline.task.failed', codec.encode(failPayload));
            log.info({ agentId: AGENT_ID }, 'Published pipeline.task.failed fallback signal');
          } catch (fallbackErr) {
            log.error({ err: fallbackErr }, 'Failed to publish fallback signal');
          }
        }
      }

      // ── Phase 5: Exit after drain ────────────────────────────────────────
      if (draining) {
        log.info({ agentId: AGENT_ID }, 'Drained — exiting after current message');
        shutdown('drain');
        break;
      }
    }
  }

  await startConsumeLoop();
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal agent runner error');
  process.exit(1);
});
