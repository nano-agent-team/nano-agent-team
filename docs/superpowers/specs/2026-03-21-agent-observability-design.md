# Agent Observability

**Date:** 2026-03-21
**Status:** Draft
**GH Issue:** TBD

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
    │  NATS: config.{agentId} { observabilityLevel: "full" }
    ▼
agent-runner — changes level in-process, no restart
```

---

## Log levels

Controlled by `OBSERVABILITY_LEVEL` env var (global, set at stack startup). Per-agent debug mode overrides this at runtime.

| Level | Text output | Tool call name | Tool call params | Tool result | Thinking blocks |
|-------|-------------|----------------|------------------|-------------|-----------------|
| `off` | — | — | — | — | — |
| `summary` | — | ✓ | — | — | — |
| `standard` | ✓ | ✓ | ✓ | ✓ | — |
| `full` | ✓ | ✓ | ✓ | ✓ | Phase 2 |

Default: `standard`.

---

## Loki log structure

Each log entry is a JSON line pushed to Loki. Labels index the stream; the log line carries the payload.

**Labels** (indexed, filterable in Grafana):

```json
{
  "agentId": "sd-developer",
  "sessionId": "ses-abc123",
  "ticketId": "TICK-0042",
  "type": "tool_call",
  "level": "standard"
}
```

`ticketId` is set from the task message received via NATS. If no ticket is associated (e.g. Foreman responding to a user message), `ticketId` is `"none"`.

**Log line payload** (JSON string, varies by event type):

```json
// type: text
{ "text": "Looking at the file structure..." }

// type: tool_call
{ "tool": "mcp__tickets__get_ticket", "params": { "id": "TICK-0042" } }

// type: tool_result
{ "tool": "mcp__tickets__get_ticket", "result": { "id": "TICK-0042", "title": "..." } }

// type: done
{ "status": "success", "durationMs": 42300 }

// type: error
{ "message": "Tool call failed", "tool": "mcp__github__create_pr" }
```

---

## Agent-runner changes

### New: `loki-client.ts`

Thin HTTP client that batches log entries and flushes to Loki every 1 second (or when batch reaches 100 entries). Fire-and-forget — log write failures are silently dropped (observability must not affect task execution).

```typescript
interface LogEntry {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  payload: Record<string, unknown>;
  ts: number; // nanoseconds (Loki requires nanosecond timestamps)
}
```

If `LOKI_URL` is unset, `loki-client.ts` becomes a no-op. Observability is disabled when Loki is not configured.

### Provider event hooks

Agent-runner already receives provider events (`text`, `tool_call`, `result`). Loki client hooks into these events without modifying existing streaming or heartbeat logic.

### Runtime level change

Agent-runner subscribes to `config.{agentId}` NATS subject (core NATS, not JetStream). On receiving `{ observabilityLevel: string }`, updates the current level in memory immediately. The override persists until agent restart.

---

## Debug mode API

**Endpoint:** `POST /api/agents/:id/debug`

**Request body:**
```json
{ "enabled": true }
```

**Behavior:**
- `enabled: true` → publishes `config.{agentId}` with `{ observabilityLevel: "full" }`
- `enabled: false` → publishes with `{ observabilityLevel: "<OBSERVABILITY_LEVEL env var>" }` (resets to global default)

**Response:** `200 { "agentId": "sd-developer", "observabilityLevel": "full" }`

The control plane does not persist this state — it is a runtime override only. Agent restart resets to the global default.

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

If Grafana is already running (e.g. for Prometheus), only Loki is added as a new data source.

### Agent-runner env vars

```yaml
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
│   ├── prometheus.yaml   # existing
│   └── loki.yaml         # new
└── dashboards/
    └── nano-agent-team.json   # new: agent logs dashboard
```

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

Agent-runner registers context at task start via the context holder. The credential proxy reads `x-session-id` from incoming Anthropic API requests, looks up context, and pushes raw LLM stream events (including thinking blocks) to Loki with full labels.

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
| `NATS core` subscription in agent-runner for `config.{agentId}` | New — agent-runner already uses NATS JetStream; core sub is a small addition |
| Provider event hooks in agent-runner | Existing events, new listener |
| `POST /api/agents/:id/debug` endpoint | New |
