# Agent Observability

**Date:** 2026-03-21
**Status:** Draft
**GH Issue:** nano-agent-team #90

---

## Overview

Agent Observability gives nano-agent-team structured, searchable visibility into what every agent does during task execution. Logs are collected by the agent-runner and stored in Grafana Loki — the same observability stack that already holds Prometheus metrics. Grafana becomes the single UI for both metrics and logs.

This spec covers **Phase 1**: agent-runner log collection. Phase 2 (thinking block capture via credential proxy + context holder) is a separate spec.

---

## Goals

- See what every agent did on every task: text output, tool calls, results
- Filter and search logs by agent, ticket, session, event type
- Toggle an agent into debug mode at runtime without restart
- Reuse existing Grafana instance — no new UI tooling

---

## Architecture

```
agent-runner
    │
    │  HTTP POST /loki/api/v1/push
    ▼
Loki :3100  ←──────────────────────────────────────────┐
    │                                                   │
    │  LogQL queries                              (Phase 2: proxy
    ▼                                              intercept for
Grafana :3003                                      thinking blocks)
    │
    ├── Logs (Loki data source)
    └── Metrics (Prometheus data source — existing)
```

**Debug mode toggle:**

```
POST /api/agents/:id/debug
    │
    │  NATS: agent.{agentId}.config { observabilityLevel: "full" }
    ▼
agent-runner — changes level in-process, no restart
```

---

## Log levels

Controlled by `OBSERVABILITY_LEVEL` env var (global, set at stack startup). Per-agent debug mode overrides this at runtime.

| Level | Text output | Tool call name | Tool call params | Tool result | Thinking blocks | `done`/`error` events |
|-------|-------------|----------------|------------------|-------------|-----------------|----------------------|
| `off` | — | — | — | — | — | — |
| `summary` | — | ✓ | — | — | — | ✓ |
| `standard` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `full` | ✓ | ✓ | ✓ | ✓ | Phase 2 | ✓ |

`done` and `error` events are emitted at all levels except `off` — they are lifecycle signals, not content.

Default: `standard`.

---

## Loki log structure

Each log entry is a JSON line pushed to Loki. Labels index the stream; the log line carries the payload.

**Labels** (indexed, filterable in Grafana — keep small set to avoid high cardinality):

```json
{
  "agentId": "sd-developer",
  "type": "tool_call",
  "level": "standard"
}
```

Only `agentId`, `type`, and `level` are Loki stream labels. The `type` label value is set directly from `LogEntry.type` — the same values used in the log levels table (`text`, `tool_call`, `tool_result`, `done`, `error`). High-cardinality values (`sessionId`, `ticketId`) are included in the JSON log line payload — they remain searchable via LogQL `| json` but do not create a new Loki stream per value.

`ticketId` is set from the task message received via NATS. If no ticket is associated (e.g. Foreman responding to a user message), `ticketId` in the payload is `"none"`.

**sessionId source:** The agent-runner's current session ID (stored in `SESSION_ID_FILE` and already tracked in memory). For ephemeral agents that have no persistent session, a UUID is generated per task start. The session ID is included in every log line payload for correlation.

**Log line payload** (JSON string — includes sessionId and ticketId for correlation):

```json
// type: text
{ "sessionId": "ses-abc123", "ticketId": "TICK-0042", "text": "Looking at the file structure..." }

// type: tool_call
{ "sessionId": "ses-abc123", "ticketId": "TICK-0042", "tool": "mcp__tickets__get_ticket", "params": { "id": "TICK-0042" } }

// type: tool_result
{ "sessionId": "ses-abc123", "ticketId": "TICK-0042", "tool": "mcp__tickets__get_ticket", "result": { "id": "TICK-0042", "title": "..." } }

// type: done
{ "sessionId": "ses-abc123", "ticketId": "TICK-0042", "status": "success", "durationMs": 42300 }

// type: error
{ "sessionId": "ses-abc123", "ticketId": "TICK-0042", "message": "Tool call failed", "tool": "mcp__github__create_pr" }
```

---

## Agent-runner changes

### New: `loki-client.ts`

Thin HTTP client that batches log entries and flushes to Loki every 1 second (or when batch reaches 100 entries). Fire-and-forget — log write failures are silently dropped (observability must not affect task execution).

```typescript
interface LogEntry {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  payload: Record<string, unknown>;
  ts: number; // nanoseconds — use Date.now() * 1_000_000 (ms → ns)
}
```

If `LOKI_URL` is unset, `loki-client.ts` becomes a no-op. Observability is disabled when Loki is not configured.

`loki-client.ts` exposes an async `flush()` method that resolves after the in-flight batch is delivered or a 2-second timeout expires. The agent-runner `await`s `flush()` during graceful shutdown (before process exit) to drain buffered entries. For ephemeral agents that exit immediately after a task, this ensures the final events (e.g. `done`) are not silently dropped.

### Provider event hooks

Agent-runner already receives provider events (`text`, `tool_call`, `result`). Loki client hooks into these events without modifying existing streaming or heartbeat logic.

### Runtime level change

Agent-runner subscribes to `agent.{agentId}.config` on **core NATS** (not JetStream). The control plane publishes to this subject via **core NATS publish** as well — not via JetStream. This is intentional: config override messages are ephemeral and must not be persisted in the `AGENTS` JetStream stream.

The `AGENTS` stream currently filters on `agent.>`, which would capture `agent.{id}.config` messages. To prevent this, the `AGENTS` stream filter must be narrowed to exclude config subjects. The concrete change: replace the stream's single `agent.>` filter subject with an explicit list: `agent.*.inbox`, `agent.*.task` (or whatever the actual filter subjects are). `agent.*.config` is intentionally excluded from the stream filter.

If narrowing the stream filter is too disruptive, an alternative is to use a different top-level subject for runtime signals: `agentcfg.{agentId}` — outside `agent.>` entirely and therefore never captured by `AGENTS`. The chosen approach must be specified at implementation time and documented in the stream definition.

This is a new convention: `agent.{agentId}.{signal}` is the format for per-agent runtime signals delivered on core NATS only (if the stream filter approach is used).

No NATS server ACL changes are required — `agent.>` is already an allowed subject pattern for agents.

---

## Debug mode API

**Endpoint:** `POST /api/agents/:id/debug`

**Request body:**
```json
{ "enabled": true }
```

**Behavior:**
- `enabled: true` → publishes `agent.{agentId}.config` with `{ observabilityLevel: "full" }`
- `enabled: false` → publishes with `{ observabilityLevel: "<value>" }` where the value is read from the control plane's own `OBSERVABILITY_LEVEL` env var at the time of the reset call. This is the correct default for agents that were started after the last control-plane restart. Agents that were started before the last control-plane restart, or with a manually overridden level, will not have their exact original value restored. This is an accepted limitation — debug mode is a temporary diagnostic tool, not a precision toggle.

**Response:** `200 { "agentId": "sd-developer", "observabilityLevel": "full" }`

The control plane does not persist this state — it is a runtime override only. Agent restart resets to the global default.

Per-agent observability level is **not** a field in `AgentManifest`. The manifest controls which tools an agent can use; observability level is a control-plane concern. The only per-agent override mechanism is this runtime debug API.

---

## Docker Compose changes

Two new services added to `docker-compose.yml` (and `docker-compose.dev.yml`):

### Loki

```yaml
loki:
  image: grafana/loki:2.9.0
  ports:
    - "3100:3100"
  command: -config.file=/etc/loki/local-config.yaml
  volumes:
    - loki-data:/loki
```

Loki local config uses the default filesystem storage. No object store required.

### Grafana

```yaml
grafana:
  image: grafana/grafana:10.2.0
  ports:
    - "3003:3000"
  environment:
    - GF_AUTH_ANONYMOUS_ENABLED=true
    - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
  volumes:
    - grafana-data:/var/lib/grafana
    - ./grafana/provisioning:/etc/grafana/provisioning
```

This spec assumes Grafana is not yet running. If Grafana is already running in a separate setup, skip the Grafana service block and add only the Loki data source to the existing instance's provisioning directory.

### Agent-runner env vars

Agent containers are created dynamically by `AgentManager` — docker-compose env blocks do not reach agent containers. `LOKI_URL` and `OBSERVABILITY_LEVEL` must be added to **both** `env = [` blocks in `agent-manager.ts` (the start path and the rollover/restart path). This follows the same pattern as `HOST_DATA_DIR`, `HOST_CLAUDE_DIR`, and `HOST_OBSIDIAN_VAULT_PATH`.

The control plane's own docker-compose service receives `LOKI_URL` and `OBSERVABILITY_LEVEL` as well — these are used by the debug reset endpoint to read the global default level.

```yaml
# control-plane service in docker-compose.yml
environment:
  - LOKI_URL=http://loki:3100
  - OBSERVABILITY_LEVEL=standard  # off | summary | standard | full
```

---

## Grafana provisioning

Pre-configured as code under `grafana/provisioning/`:

```
grafana/provisioning/
├── datasources/
│   ├── prometheus.yaml       # existing
│   └── loki.yaml             # new
└── dashboards/
    ├── dashboards.yaml       # new: Grafana dashboard provider config
    └── nano-agent-team.json  # new: static dashboard export committed to repo
```

`dashboards.yaml` tells Grafana to load dashboards from the provisioning folder:
```yaml
apiVersion: 1
providers:
  - name: nano-agent-team
    folder: nano-agent-team
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards
```

`nano-agent-team.json` is a Grafana dashboard JSON export committed to the repository. It is not auto-generated — it must be hand-crafted or exported from Grafana and committed under `grafana/provisioning/dashboards/`.

**`loki.yaml` data source:**
```yaml
apiVersion: 1
datasources:
  - name: Loki
    type: loki
    url: http://loki:3100
    isDefault: false
```

**Default dashboard panels:**
- Log stream for selected agent (label filter: `agentId`)
- Tool calls timeline (filter: `type="tool_call"`)
- Error log (filter: `type="error"`)
- Live tail for active sessions

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `LOKI_URL` | *(unset)* | Loki push endpoint. Observability disabled if unset. |
| `OBSERVABILITY_LEVEL` | `standard` | Global log level: `off` / `summary` / `standard` / `full` |

---

## Phase 2 — thinking blocks (deferred)

Phase 2 adds capture of Claude's internal reasoning (extended thinking blocks) by intercepting at the credential proxy layer. The key design element is a **context holder**: a lightweight in-memory KV store in the control plane that maps `sessionId → { agentId, ticketId }`.

Agent-runner registers context at task start by POSTing to a new `/internal/log-context` endpoint on the control plane: `{ sessionId, agentId, ticketId }`. The control plane stores this in an in-memory Map. The credential proxy reads `x-session-id` from incoming Anthropic API requests (injected by agent-runner via Anthropic SDK `defaultHeaders`), looks up context in the control plane's Map, and pushes raw LLM stream events (including thinking blocks) to Loki with full labels.

The Phase 2 spec must address `/internal/log-context` endpoint authentication. The current expectation is that internal Docker network isolation is sufficient (only agent containers can reach the control plane's internal port), but this must be confirmed in the Phase 2 spec.

This is a separate spec. Phase 1 does not depend on it.

---

## What this is not

- **Not a replacement for stdout/stderr logs** — Pino logs to stderr remain unchanged. Loki is for structured agent activity, not control-plane operational logs.
- **Not real-time agent output in the dashboard** — the existing SSE stream for ticket progress remains separate. Loki is for historical search and debugging.
- **Not a tracing system** — OTel traces remain in the agent-runner but are not surfaced in this spec.

---

## Dependencies

| Dependency | Status |
|-----------|--------|
| Grafana Loki Docker image | New service |
| Grafana Docker image (or existing) | New service or extend existing |
| `NATS core` subscription in agent-runner for `agent.{agentId}.config` | New — agent-runner already uses NATS JetStream; core sub is a small addition; no ACL changes needed |
| Provider event hooks in agent-runner | Existing events, new listener |
| `POST /api/agents/:id/debug` endpoint | New |
