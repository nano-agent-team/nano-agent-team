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
  health.>               ─┘         ├─→ AlarmClock MCP (set next alarm)
                                    ├─→ MCP tools (list_tickets, dispatch, ...)
alarm.sd-pm  ────────────────────→  │
                                    └─→ Obsidian reflect
                                           ├─ sd-pm-state.md (live state)
                                           └─ Daily/YYYY-MM-DD.md (archive)
```

---

## Event Signals

sd-pm subscribes to the following NATS subjects:

| Signal | Trigger | Action |
|--------|---------|--------|
| `topic.ticket.created` | New ticket arrives | Evaluate, prioritize, dispatch to pipeline |
| `topic.deploy.done` | Deploy completed | Mark ticket done, free pipeline slot |
| `topic.ticket.updated` | Status change (blocked, failed, needs-review) | Update state, unblock dependents |
| `health.>` | Agent heartbeat | Track which pipeline agents are idle/busy |
| `alarm.sd-pm` | Self-scheduled wakeup | Process backlog, retry stalled tickets, set next alarm |

### Rolling Alarm Pattern

After every wakeup triggered by `alarm.sd-pm`, sd-pm:
1. Processes any pending backlog
2. Evaluates current pipeline utilization
3. Sets next alarm via AlarmClock MCP — interval is self-determined:
   - High activity (3+ active tickets): short interval
   - Low activity (idle pipeline): long interval

This keeps sd-pm in control of its own scheduling without busy-looping or external dependencies.

---

## Memory Architecture

### Live State File

**Path:** `~/Documents/Claude-Brain/Projects/sd-pm-state.md`

Mounted into the agent container via `HOST_OBSIDIAN_VAULT_PATH` (existing env var pattern). Updated after every event processed.

```markdown
# SD-PM State
Updated: 2026-03-22 14:30

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

### Session Rollover

When the sd-pm container restarts (session rollover or crash), the agent-runner loads `sd-pm-state.md` as the first message in the new session. Context is restored immediately — no cold start.

This requires `sd-pm-state.md` path to be injected as `PM_STATE_FILE` env var in the agent container (same pattern as `HOST_OBSIDIAN_VAULT_PATH`).

### Periodic Archival (Reflect)

Three levels of reflect, triggered by sd-pm itself:

| Trigger | Action |
|---------|--------|
| After every event | Update `sd-pm-state.md` (lightweight overwrite) |
| After every alarm wakeup | Append brief entry to today's Obsidian Daily note |
| Once per day (first alarm after midnight) | Full `/reflect save` — complete session dump |

The daily reflect ensures that human-readable history accumulates in the Obsidian vault alongside the developer's own session notes.

---

## Agent-Manager Changes

### Container Startup

sd-pm already runs as a persistent agent (no `workspace_source`). Two new env vars must be added to the sd-pm container in `agent-manager.ts`:

```
PM_STATE_FILE=/obsidian/Projects/sd-pm-state.md
```

`/obsidian` is the mount point for `HOST_OBSIDIAN_VAULT_PATH` inside the container (already mounted for agents that use it).

### No Changes to Ephemeral Pattern

The ephemeral pattern (`workspace_source: "ticket"`) for sd-developer, sd-reviewer, sd-committer, sd-architect, sd-release-manager remains unchanged. This spec only affects sd-pm.

---

## SD-PM Agent Changes

### CLAUDE.md / System Prompt

sd-pm's system prompt must be updated to:
1. Load `PM_STATE_FILE` at session start as project context
2. After every processed event: rewrite `PM_STATE_FILE` with current state
3. After every alarm wakeup: append to today's Daily note
4. Once daily: call `/reflect save`
5. Always set next alarm via AlarmClock MCP after processing an alarm event

### AlarmClock MCP Tool

sd-pm must have `mcp__alarmclock__set_alarm` (or equivalent) in its `allowedTools`. The AlarmClock MCP server must be available in the stack.

AlarmClock MCP is tracked in GH Issue #84 (CronScheduler / AlarmClock). This spec depends on #84.

---

## Configuration

| Env var | Value | Description |
|---------|-------|-------------|
| `PM_STATE_FILE` | `/obsidian/Projects/sd-pm-state.md` | Path to live state file inside container |

---

## What This Is Not

- **Not a database** — sd-pm does not use SQLite or any persistent store beyond the Obsidian markdown file
- **Not a replacement for ticket MCP tools** — sd-pm still calls `list_tickets`, `get_ticket` etc. for authoritative data; `sd-pm-state.md` is a working memory layer, not a source of truth
- **Not a new agent lifecycle** — sd-pm remains a persistent container; this spec adds memory discipline, not a new runtime mode

---

## Dependencies

| Dependency | Status |
|-----------|--------|
| AlarmClock MCP (#84) | Required — sd-pm cannot self-schedule without it |
| `HOST_OBSIDIAN_VAULT_PATH` mounted in agent containers | Existing — already implemented |
| sd-pm persistent container | Existing — already running |
| Reflect skill in sd-pm container | New — skill must be mounted/available |
