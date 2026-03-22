# Pull-over-Push: AlarmClock + Scrum-Master Agent (GH-103)

## Summary

NATS is a kick signal only — the ticketing system is the source of truth. Currently all sd-* agents are purely event-driven: if a NATS message is lost, no work happens. This design adds a deterministic scrum-master agent that polls the ticketing system and dispatches work to pipeline agents, plus simplifies the ticket status model.

## Motivation

- NATS messages are unreliable — lost messages = silently dropped work
- Current pipeline has no self-healing for stuck/orphaned tickets
- 9 ticket statuses are unnecessarily complex when `assigned_to` carries the semantic meaning

## Architecture

### Principle

Every pipeline stage must function correctly even if all NATS messages are dropped. The scrum-master agent periodically polls the ticketing system, claims work, dispatches it, and detects orphans. NATS kicks provide low-latency wakeups but are never required.

### Ticket Status Model (simplified)

| Status | Meaning |
|--------|---------|
| `idea` | New ticket, awaiting sd-pm approval |
| `waiting` | Assigned to an agent (`assigned_to`), awaiting processing |
| `in_progress` | Agent actively working on it |
| `done` | Pipeline complete |
| `rejected` | Rejected by sd-pm |

**Pipeline flow:**

```
idea → sd-pm approves → waiting (assigned_to: sd-architect)
  → scrum-master dispatches → in_progress (sd-architect working)
  → sd-architect done → waiting (assigned_to: sd-developer)
  → scrum-master dispatches → in_progress (sd-developer working)
  → ... → done
```

The pipeline stage is fully determined by `assigned_to`. Status is only `idea → waiting ↔ in_progress → done`.

**Status migration:**

| Old Status | New Status | Notes |
|------------|-----------|-------|
| `approved` | `waiting` | `assigned_to` preserved |
| `spec_ready` | `waiting` | `assigned_to` preserved |
| `review` | `waiting` | `assigned_to` preserved |
| `in_progress` | `in_progress` | No change |
| `idea` | `idea` | No change |
| `done` | `done` | No change |
| `rejected` | `rejected` | No change |
| `verified` | `done` | Dropped, mapped to done |
| `pending_input` | `waiting` | Mapped to waiting |

**Migration checklist:**
- `src/tickets/types.ts`: Update `AbstractStatus` type to `'idea' | 'waiting' | 'in_progress' | 'done' | 'rejected'`
- `src/tickets/types.ts`: Add `expected_status?: AbstractStatus` to `UpdateTicketData` interface
- `src/tickets/types.ts`: Update `STATUS_NATS_EVENTS` — simplified, see NATS Events section
- `src/tickets/local-provider.ts`: Update `LocalStatusMapper` native↔abstract mappings
- `src/tickets/github-provider.ts`: Update GitHub label↔status mappings
- `src/db.ts`: Migrate existing rows, update CHECK constraint
- `container/agent-runner/src/tickets-mcp-stdio.ts`: Update Zod schema status descriptions and add `expected_status`
- `src/mcp-gateway.ts`: Update MCP tool Zod schemas — add `expected_status`, update `.describe()` strings for new 5-status model
- `hub/agents/*/manifest.json`: Remove any `poll_interval`/`poll_statuses` fields from existing manifests

### NATS Events (simplified)

With the scrum-master handling dispatch, most NATS pipeline events become optional kick signals. The scrum-master does NOT rely on them — it polls directly.

```typescript
export const STATUS_NATS_EVENTS: Partial<Record<AbstractStatus, string>> = {
  waiting:     'topic.ticket.waiting',    // Kick: new work available
  in_progress: 'topic.ticket.claimed',    // Kick: work claimed
  done:        'topic.ticket.done',       // Kick: pipeline complete
  rejected:    'topic.ticket.rejected',   // Kick: ticket rejected
};
```

These events are informational. The pipeline works without them.

### Optimistic Claim (expected_status)

`PATCH /api/tickets/:id` gains an optional `expected_status` parameter. If provided and the current status doesn't match → 409 Conflict. This enables atomic claim without race conditions.

```
PATCH /api/tickets/TICK-001
{ "status": "in_progress", "expected_status": "waiting", "changed_by": "sd-scrum-master" }

→ 200 OK (claimed)
→ 409 Conflict (already claimed by another process)
```

**Implementation path:** `expected_status` must flow through the full stack:
1. `PATCH /api/tickets/:id` body parsing → pass to `ticketRegistry.updateTicket()`
2. `TicketRegistry.updateTicket()` → pass to provider
3. `LocalTicketProvider.updateTicket()` → check current status before UPDATE
4. `ticket_update` MCP tool Zod schema → add `expected_status` field (CRITICAL: Zod silently drops unknown params, see `Feedback/mcp-tool-zod-silent-drop.md`)
5. `tickets-mcp-stdio.ts` ticket_update tool → pass `expected_status` in HTTP PATCH body

### AlarmClock Bootstrap

Control plane sets a bootstrap alarm for the scrum-master agent during `startAgent()`. Idempotent: calls `alarmClock.cancelForAgent('sd-scrum-master')` before setting the alarm to prevent duplicates on restart/reload.

Alarm payload: `{type: "poll"}`. The scrum-master sets its own next alarm after each wakeup.

### Scrum-Master Agent

- **`kind: "deterministic"`** — uses `manifest.image` field (e.g., `"nano-deterministic:latest"`), no LLM
- **Persistent agent** with alarm-driven wakeup via NATS consumer (same as LLM agents)
- **On each wakeup:**
  1. Query `tickets WHERE status = 'waiting'` → for each: claim via `expected_status` + dispatch
  2. Query `tickets WHERE status = 'in_progress'` → orphan detection (see below)
  3. `alarm_set` for next wakeup (adaptive interval: work found → 30s, idle → 300s, queue > 5 → 15s)

**Dispatch mechanism:** Scrum-master publishes a NATS message to `agent.{assigned_to}.task` with the ticket payload. The existing ephemeral consumer in agent-manager intercepts it and spawns a container. No new dispatch mechanism needed.

**Pipeline routing:** Scrum-master does NOT determine `assigned_to`. Each agent sets `assigned_to: next_agent` when completing its work (encoded in agent's CLAUDE.md instructions). The scrum-master only dispatches to whoever `assigned_to` points to.

**MCP permissions:**
```json
{
  "tickets": ["list", "get", "update"],
  "management": ["alarm_set", "alarm_cancel", "alarm_list", "get_system_status"]
}
```

### Deterministic Runner

New container image for `kind: "deterministic"` agents:

- **Location:** `container/deterministic-runner/`
- **Base image:** Node.js 20 Alpine (same as agent-runner, minus LLM SDKs)
- **Entry point:** `src/index.ts` — reads `HANDLER` env var, imports `src/handlers/{handler}.ts`, runs handler
- **MCP access:** HTTP via MCP Gateway (`MCP_GATEWAY_URL` env var)
- **NATS:** Connects to NATS, runs JetStream consumer pull loop (same pattern as agent-runner), invokes handler on each message
- **No LLM dependencies:** No Claude SDK, no Anthropic API key, no session management

**Env vars (deterministic runner):**
| Var | Required | Description |
|-----|----------|-------------|
| `NATS_URL` | Yes | NATS server |
| `AGENT_ID` | Yes | Agent identifier |
| `CONSUMER_NAME` | Yes | JetStream consumer name |
| `MCP_GATEWAY_URL` | Yes | MCP Gateway HTTP endpoint |
| `HANDLER` | Yes | Handler module name (e.g., `scrum-master`) |
| `DB_PATH` | Yes | SQLite DB path for read-only queries (mutations via MCP only) |
| `LOG_LEVEL` | No | Default: `info` |

**NOT needed:** `ANTHROPIC_API_KEY`, `MODEL`, `SESSION_TYPE`, `AGENT_SYSTEM_PROMPT`, `AGENT_ALLOWED_TOOLS`, provider-specific tokens.

**Handler interface:**
```typescript
export interface HandlerContext {
  agentId: string;
  nc: NatsConnection;       // Direct NATS access for publishing
  mcpGatewayUrl: string;    // MCP Gateway for ALL ticket mutations
  db: Database;             // Read-only SQLite connection for fast queries
  log: Logger;
}

export type Handler = (payload: unknown, ctx: HandlerContext) => Promise<void>;
```

**Invariant:** All ticket mutations (status changes, assigned_to, comments) MUST go through MCP Gateway. The `db` connection is opened read-only (`{ readonly: true }`) and is for fast list/query operations only. This ensures TicketRegistry publishes NATS events and records history on every change.

**Agent-manager changes:**
- `buildAgentEnvAndBinds()`: if `manifest.kind === 'deterministic'`, skip LLM-specific env vars, add `HANDLER` env var
- Image selection: use `manifest.image` field (existing field, already supported). Scrum-master manifest sets `"image": "nano-deterministic:latest"`
- **Dual env blocks:** Both persistent and ephemeral env blocks must handle `kind === 'deterministic'` (skip LLM tokens, add HANDLER). See `Feedback/agent-manager-dual-env-blocks.md`.

### Agent Flow (ephemeral sd-*)

1. Scrum-master claims ticket (`waiting` → `in_progress` via `expected_status`) and publishes NATS message to `agent.{assigned_to}.task`
2. Agent-manager's ephemeral consumer spawns container with ticket payload
3. Agent processes ticket
4. Agent sets `status: waiting, assigned_to: next_agent` via `ticket_update` MCP tool (next agent is hardcoded in each agent's CLAUDE.md)
5. Agent exits
6. Scrum-master picks up the `waiting` ticket on next wakeup and dispatches to next agent

**Workspace creation:** sd-pm continues to create workspaces during approval (existing behavior, no change).

### Orphan Detection (self-healing)

On each poll wakeup, scrum-master checks all `in_progress` tickets:

1. For each ticket: check `updated_at` timestamp — if less than 30s ago (2× heartbeat interval), skip (grace period for newly claimed tickets)
2. Check heartbeats via `get_system_status`: is there a running agent instance working on this ticket?
3. If yes → ok, leave it
4. If no → orphan → revert `status: waiting` (keeps same `assigned_to` so same agent type picks it up again)

**Heartbeat matching:** Add `ticketId` field to heartbeat payload (alongside existing `task` field) for reliable matching. Agent-runner extracts `ticket_id` from incoming message payload and includes it in heartbeats.

**Retry limit:** Track orphan recovery count via ticket comments (e.g., "Orphan recovery #2"). After 3 recoveries, set `status: rejected` with comment explaining the failure pattern. sd-pm or foreman can investigate.

### Removing per-agent polling

The earlier per-agent polling mechanism (`AGENT_POLL_INTERVAL_SECONDS`, `AGENT_POLL_STATUSES` env vars in agent-runner) is deprecated and removed. The scrum-master handles all polling centrally. Remove:
- `AGENT_POLL_INTERVAL_SECONDS` / `AGENT_POLL_STATUSES` from agent-runner config
- `poll_interval` / `poll_statuses` from `AgentManifest` (added prematurely)
- Related env var pass-through in agent-manager

## Components

| Component | Change Type | Description |
|-----------|-------------|-------------|
| `src/tickets/types.ts` | Modify | Simplify AbstractStatus to 5 states, update STATUS_NATS_EVENTS |
| `src/tickets/local-provider.ts` | Modify | Add `expected_status` support, update LocalStatusMapper |
| `src/tickets/github-provider.ts` | Modify | Update status label mappings |
| `src/api-server.ts` | Modify | Pass `expected_status` from PATCH body, return 409 on mismatch |
| `src/mcp-gateway.ts` | Modify | Add `expected_status` to ticket_update Zod schema |
| `src/agent-registry.ts` | Modify | Add `handler?: string` field to AgentManifest |
| `src/agent-manager.ts` | Modify | Handle `kind: 'deterministic'` (image, env vars), bootstrap alarm |
| `src/db.ts` | Modify | Migrate status values, update CHECK constraint |
| `container/agent-runner/src/index.ts` | Modify | Add `ticketId` to heartbeat payload, remove poll env vars |
| `container/agent-runner/src/tickets-mcp-stdio.ts` | Modify | Add `expected_status` to ticket_update Zod schema |
| `container/deterministic-runner/` | Create | New Docker image for deterministic agents |
| `container/deterministic-runner/src/index.ts` | Create | NATS consumer + handler dispatch |
| `container/deterministic-runner/src/handlers/scrum-master.ts` | Create | Polling + orphan detection + dispatch logic |
| `hub/agents/sd-scrum-master/manifest.json` | Create | Scrum-master agent definition |
| `hub/agents/sd-*/CLAUDE.md` | Modify | Update for new status model (waiting/in_progress), set assigned_to: next_agent |
| `hub/teams/self-dev-team/workflow.json` | Modify | Add sd-scrum-master (alarm-only, no topic bindings) |

## Implementation Phases

### Phase 0: Consolidate to main
- Review all open branches, identify unpushed commits
- Merge ready branches to main
- Start fresh feature branch from clean main

### Phase 1: Status refactor + expected_status
- Simplify AbstractStatus to `idea | waiting | in_progress | done | rejected`
- Update LocalStatusMapper, GitHubProvider status mappings
- Add `expected_status` to PATCH endpoint, TicketRegistry, LocalTicketProvider
- Add `expected_status` to MCP tool Zod schemas (mcp-gateway + tickets-mcp-stdio)
- Migrate existing DB data, update CHECK constraint
- Update STATUS_NATS_EVENTS
- Add `ticketId` field to agent-runner heartbeat payload
- Remove `poll_interval`/`poll_statuses` from AgentManifest and agent-manager

### Phase 2: Deterministic runner
- Create `container/deterministic-runner/` (Dockerfile, package.json, tsconfig)
- Implement NATS consumer + handler dispatch in `src/index.ts`
- Define handler interface
- Agent-manager: skip LLM env vars for `kind: 'deterministic'`, add HANDLER env var
- Agent-manager: use `manifest.image` for image selection (already supported)
- Agent-manager: bootstrap alarm with idempotent `cancelForAgent()` + `set()`
- Build pipeline: add deterministic-runner to build commands

### Phase 3: Scrum-master agent
- Implement `scrum-master` handler: poll → claim → dispatch → orphan detect → alarm
- Create `hub/agents/sd-scrum-master/manifest.json`
- Add to `hub/teams/self-dev-team/workflow.json` (alarm-only, no topic bindings)
- Test: ticket stuck in `waiting` gets dispatched
- Test: orphaned `in_progress` ticket gets reverted after grace period
- Test: retry limit triggers rejection after 3 orphan recoveries

### Phase 4: sd-* agent updates
- Update all sd-* CLAUDE.md for new status model
- Each agent: after work, set `waiting, assigned_to: next_agent` (pipeline order in CLAUDE.md)
- Existing NATS topic bindings remain as kick signals (scrum-master is the reliability layer)

### Phase 5: Cleanup + validation
- Remove old status values from codebase
- Update dashboard status filters
- End-to-end test: create ticket, verify full pipeline with scrum-master dispatch
- Close GH-103

## Non-Goals

- AlarmClock MCP tool changes (already works)
- NATS removal (NATS stays as kick signal for low-latency)
- Multi-instance scrum-master (single instance sufficient)
- Per-agent bearer token auth (GH #94, separate concern)

## Risks

| Risk | Mitigation |
|------|------------|
| Status migration breaks existing tickets | Phase 1 includes data migration script, test with existing DB |
| CLAUDE.md updates missed for some agents | Checklist in Phase 4, enumerate all sd-* agents |
| Deterministic runner adds build complexity | Reuse agent-runner base image, minimal deps |
| Orphan false positives from heartbeat lag | 30s grace period (2× heartbeat interval) |
| Infinite orphan loop on crashing tickets | Retry limit (3), then reject with comment |
| x-agent-id spoofing (scrum-master impersonation) | Known limitation, depends on GH #94 for fix |
