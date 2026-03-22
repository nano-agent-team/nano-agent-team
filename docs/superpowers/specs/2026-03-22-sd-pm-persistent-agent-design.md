# SD-PM: Persistent Event-Driven Agent with Obsidian Memory

**Date:** 2026-03-22
**Status:** Draft
**GH Issue:** TBD

---

## Overview

sd-pm is a persistent, long-running agent that coordinates the self-dev pipeline. Unlike ephemeral agents (which process a single task and exit), sd-pm maintains a continuous overview of all active tickets, pipeline slot availability, and cross-ticket dependencies. Its memory survives session rollovers via a live state file in Obsidian.

---

## Goals

- sd-pm has full project context at all times — active tickets, pipeline state, decisions, blockers
- Memory persists across session rollovers without manual intervention
- sd-pm wakes itself up via AlarmClock MCP (no external heartbeat dependency)
- Human-readable project state visible in Obsidian alongside daily notes

---

## Architecture

```
NATS events
  topic.ticket.created   ─┐
  topic.deploy.done       ├─→  sd-pm (persistent container)
  topic.ticket.updated    │         │
  health.> (core NATS)   ─┘         ├─→ AlarmClock MCP (set next alarm)
  alarm.sd-pm  ──────────────────→  ├─→ MCP tools (list_tickets, update_ticket, dispatch, ...)
                                    └─→ Obsidian (direct file writes)
                                           ├─ sd-pm-state.md (live state)
                                           └─ Daily/YYYY-MM-DD.md (archive)
```

---

## Event Signals

sd-pm subscribes to the following NATS subjects:

| Signal | Transport | Trigger | Action |
|--------|-----------|---------|--------|
| `topic.ticket.created` | JetStream | New ticket arrives | Evaluate, prioritize, dispatch to pipeline |
| `topic.deploy.done` | JetStream | Deploy completed | Mark ticket done, free pipeline slot |
| `topic.ticket.updated` | JetStream | Status change (blocked, failed, needs-review) | Update state, unblock dependents |
| `health.>` | Core NATS | Agent heartbeat | Update in-memory pipeline slot state |
| `alarm.sd-pm` | JetStream | Self-scheduled wakeup | Process backlog, retry stalled tickets, set next alarm |

### health.> Subscription Model

`health.>` is subscribed via a **core NATS subscription** (not JetStream). Health heartbeat updates are held in memory only and **debounced** — the in-memory slot state is updated on every heartbeat, but the state file is only written as part of alarm or ticket event processing (not on every heartbeat). This avoids writing the Obsidian file 8+ times per minute during normal operation.

An agent is considered unavailable if its last heartbeat is older than 60 seconds (same threshold used by the control plane health monitor). When an agent goes stale mid-task, sd-pm marks that pipeline slot as `unknown` in the state file and retries the affected ticket on the next alarm wakeup.

### JetStream Consumer Configuration

sd-pm's JetStream consumers for `topic.>` and `alarm.sd-pm` use:
- `deliver_policy: all` with sequence tracking — ensures no ticket events are missed after a crash or session rollover. This is required because `deliver_policy: new` would silently drop events that arrived during the downtime window (see `Feedback/jetstream-deliver-policy-new.md`).
- `AckExplicit` — sd-pm acknowledges each message only after fully processing it and writing the updated state file.
- Durable consumer names scoped to `instanceId` (not `manifest.id`) — prevents multiple sd-pm instances from competing for the same consumer if multi-instance is ever enabled. For now, sd-pm runs as a single instance, but this scoping is forward-compatible.

### Rolling Alarm Pattern

`alarm.sd-pm` is delivered via JetStream to a durable consumer scoped to sd-pm's `instanceId`. sd-pm is treated as single-instance (no multi-instance dispatch). On each alarm wakeup:

1. Process any pending backlog (ticket retries, blocked tickets now unblocked)
2. Flush in-memory pipeline slot state to state file (atomic write)
3. Acknowledge the alarm message (JetStream AckExplicit)
4. Evaluate pipeline utilization
5. Set next alarm via AlarmClock MCP:
   - High activity (3+ active tickets): short interval
   - Low activity (idle pipeline): long interval
   - If AlarmClock MCP is unavailable: log warning in state file, rely on incoming NATS events to re-trigger activity (graceful degradation to reactive-only mode)

Steps 2 and 3 must happen before step 5.

---

## Memory Architecture

### Live State File

**Path (host):** `~/Documents/Claude-Brain/Projects/sd-pm-state.md`
**Path (container):** `/obsidian/Projects/sd-pm-state.md` (via `HOST_OBSIDIAN_VAULT_PATH` mount)

Updated after every ticket/alarm event processed using a **write-to-temp-then-rename** pattern. The temp file must be created in the **same directory** as the state file (`/obsidian/Projects/`) — not in `/tmp` or any other path — to avoid cross-device rename failure on the Docker bind mount.

```markdown
# SD-PM State
Updated: 2026-03-22 14:30
Last-Summary-Date: 2026-03-22

## Active Tickets
- TICK-0042: in-progress (sd-developer), branch feat/observability
- TICK-0043: queued — waiting for TICK-0042

## Pipeline Slots
- sd-developer: busy (TICK-0042)
- sd-reviewer: idle
- sd-committer: idle
- sd-architect: idle

## Recent Decisions
- TICK-0041: rejected — duplicate of #38, 2026-03-22

## Blocked / Needs Attention
- TICK-0043: dependency unresolved, check on next alarm

## Last Alarm
- 2026-03-22 14:28 — 1 ticket active, next alarm in 15 min
```

`sd-pm-state.md` is linked from Daily notes via `[[sd-pm-state]]` for human visibility.

### Bootstrap (First Run)

If `sd-pm-state.md` does not exist at container startup (first deployment, vault wipe, or misconfigured path), sd-pm creates the file with an empty initial template:

```markdown
# SD-PM State
Updated: <startup timestamp>
Last-Summary-Date: <today>

## Active Tickets
(none yet)

## Pipeline Slots
(unknown — will populate from health.> heartbeats)

## Recent Decisions
(none yet)

## Blocked / Needs Attention
(none yet)

## Last Alarm
(not set)
```

After creating the bootstrap file, sd-pm calls `list_tickets` via MCP to populate the Active Tickets section before processing any queued events.

### Session Rollover

When the sd-pm container restarts (session rollover or crash), agent-runner reads `PM_STATE_FILE` at startup and prepends its contents as the first user message before the initial `query()` call. This is a **generic agent-runner feature** triggered by the presence of the `PM_STATE_FILE` env var — it is not sd-pm-specific and can be reused by future persistent agents with memory requirements. The feature:

- Reads the file at `PM_STATE_FILE` path on startup
- Prepends contents as the first user message in the new session
- If `PM_STATE_FILE` is set but the path is unreachable (vault not mounted, file not found): logs a warning, continues with empty context — sd-pm recovers by calling `list_tickets` on startup
- Does not interfere with the existing session resume path: state injection happens before the NATS subscription loop starts, completing before the first `query()` call

### Known Limitations

- **One-event staleness after crash:** The atomic rename pattern guarantees no partial writes, but if a crash occurs before the rename, the state file reflects the previous event. sd-pm recovers by calling `list_tickets` on startup (same as bootstrap recovery). This one-event gap is an accepted limitation.
- **Multi-day idle gap:** If sd-pm is idle for multiple days (long alarm intervals, no ticket events), only one daily summary is written when activity resumes. Intermediate idle days are not archived.

### Periodic Archival (Direct File Writes)

sd-pm writes to Obsidian directly via filesystem tool calls — it does not use the Claude Code `/reflect` skill (which is a host-side tool, not available inside a container). The three levels:

| Trigger | Action |
|---------|--------|
| After every ticket/alarm event | Overwrite `sd-pm-state.md` (atomic write, temp-in-same-dir) |
| After every alarm wakeup | Append brief summary line to today's Daily note |
| Date change detected | Write full session summary to Daily note |

**Daily archive trigger:** At the start of each alarm wakeup, sd-pm compares the current date to the `Last-Summary-Date` field stored in `sd-pm-state.md`. If the date has changed, the full daily summary is written and `Last-Summary-Date` is updated. Using a dedicated `Last-Summary-Date` field (rather than parsing `Updated:`) makes this comparison robust to format changes and survives session rollover.

**Daily note path:** If today's Daily note (`/obsidian/<PM_DAILY_NOTE_DIR>/YYYY-MM-DD.md`) does not yet exist, sd-pm creates it with a minimal header before appending.

---

## Ticket Dispatch — Write-Ahead Pattern

To prevent double-dispatch after a crash, sd-pm uses a write-ahead pattern:

1. Call `update_ticket(ticketId, { status: "dispatched" })` via MCP **before** publishing the NATS dispatch message
2. Publish NATS dispatch message to target agent
3. Update state file

On restart, `list_tickets` returns `status: dispatched` for in-flight tickets — sd-pm does not re-dispatch them. If the container crashed between step 1 and step 2, the ticket is left in `dispatched` state with no agent processing it. sd-pm treats stale `dispatched` tickets (no agent heartbeat for >2 minutes after dispatch) as failed and re-dispatches on the next alarm.

---

## Agent-Manager Changes

### New Env Vars for sd-pm Container

The following env vars must be added to sd-pm's container in **both** `env =` blocks in `agent-manager.ts` (start path and rollover/restart path — same two-block pattern as `HOST_DATA_DIR` and `HOST_OBSIDIAN_VAULT_PATH`):

```
HOST_OBSIDIAN_VAULT_PATH=<host path>   # if not already present for sd-pm
PM_STATE_FILE=/obsidian/Projects/sd-pm-state.md
PM_DAILY_NOTE_DIR=Daily
```

If `HOST_OBSIDIAN_VAULT_PATH` is already present in sd-pm's env blocks from a prior change, only `PM_STATE_FILE` and `PM_DAILY_NOTE_DIR` need to be added. Missing one of the two env blocks is a known silent failure mode (`Feedback/host-obsidian-vault-both-env-blocks.md`).

### NATS Stream Coverage for `alarm.>`

The existing `AGENTS` JetStream stream covers `agent.>`, `topic.>`, and `health.>`. Alarm messages published by AlarmClock MCP to `alarm.sd-pm` are not currently captured. Add `alarm.>` to the `AGENTS` stream subject list. AlarmClock MCP must publish to the `alarm.` namespace by convention.

### No Changes to Ephemeral Pattern

The ephemeral pattern for sd-developer, sd-reviewer, sd-committer, sd-architect, sd-release-manager remains unchanged.

---

## SD-PM Agent Changes

### CLAUDE.md / System Prompt

sd-pm's system prompt must be updated to:

1. On startup: context is already injected by agent-runner; call `list_tickets` to fill any gaps
2. Before dispatching any ticket: call `update_ticket(id, { status: "dispatched" })` first (write-ahead)
3. After every ticket/alarm event: atomically overwrite `PM_STATE_FILE` (temp-in-same-dir rename)
4. After every alarm wakeup: append summary to Daily note at `/obsidian/<PM_DAILY_NOTE_DIR>/YYYY-MM-DD.md` (create if missing)
5. On date change (`Last-Summary-Date` field): write full daily summary to Daily note
6. Always set next alarm via AlarmClock MCP after processing an alarm event (log warning in state file if unavailable)

### AlarmClock MCP Tool

sd-pm must have the AlarmClock MCP tool in its `allowedTools`. Dependency on GH Issue #84 (planned, not yet implemented).

---

## Configuration

| Env var | Value | Scope | Description |
|---------|-------|-------|-------------|
| `HOST_OBSIDIAN_VAULT_PATH` | e.g. `/Users/user/Documents/Claude-Brain` | Both env blocks | Host path for Obsidian vault mount — required for state file access |
| `PM_STATE_FILE` | `/obsidian/Projects/sd-pm-state.md` | Both env blocks | Container-internal path to live state file; triggers state injection in agent-runner on startup |
| `PM_DAILY_NOTE_DIR` | `Daily` | Both env blocks | Subdirectory within vault for daily notes (default: `Daily`) |

---

## What This Is Not

- **Not a database** — sd-pm does not use SQLite or any persistent store beyond the Obsidian markdown file
- **Not a replacement for ticket MCP tools** — `sd-pm-state.md` is a working memory layer, not a source of truth; MCP tools remain authoritative
- **Not a new agent lifecycle** — sd-pm remains a persistent container; this spec adds memory discipline and event subscriptions
- **Not using the Claude Code reflect skill** — sd-pm writes Obsidian files directly via filesystem tool calls

---

## Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| AlarmClock MCP (#84) | Planned, not yet implemented — **this spec is blocked on #84** | Without it, sd-pm degrades to reactive-only mode |
| `alarm.>` added to AGENTS JetStream stream | New — required for alarm delivery | Concrete change: add subject to stream filter list |
| `HOST_OBSIDIAN_VAULT_PATH` in both sd-pm env blocks | New (if not already present) | Silent failure if only one block updated |
| `PM_STATE_FILE` + `PM_DAILY_NOTE_DIR` in both sd-pm env blocks | New | Triggers agent-runner state injection |
| Agent-runner generic state injection (`PM_STATE_FILE`) | New agent-runner feature | Prepend file contents as first user message on startup |
| sd-pm persistent container | Existing | Already running |
| JetStream `deliver_policy: all` for sd-pm consumers | New — replaces any existing `deliver_policy: new` | Prevents missed events on restart |
