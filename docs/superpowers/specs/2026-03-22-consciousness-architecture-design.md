# Consciousness Architecture — Strategic Agent Layer

**Date:** 2026-03-22
**Status:** Draft
**GH Issue:** TBD

---

## Overview

The Consciousness Architecture introduces a strategic layer above the existing operational pipeline. It consists of four agents present at every system startup: **consciousness**, **conscience**, **strategist** (self-named at init), and **Foreman**. The architecture is universal — it works equally for a personal assistant instance ("Bohumil, family assistant") or a virtual company instance.

This spec also establishes a system-wide architectural principle: **NATS is a kick signal only — the ticketing system and Obsidian are the sources of truth.**

---

## Architectural Principle: Pull Over Push

NATS messages are unreliable delivery-optimizations, not truth carriers. Every agent must function correctly even if all NATS messages are dropped.

| Source of truth | Domain |
|----------------|--------|
| **Ticketing system** | Work to be done — queue, status, priorities |
| **Obsidian vault** | Knowledge, ideas, memory, goals, values |
| **NATS** | Kick signal only — reduces latency, never required |

**Every agent is pull-based:** on each AlarmClock wakeup, the agent reads its own queue from the ticketing system directly. A NATS kick adds an extra wakeup — it never replaces the periodic pull. Lost NATS messages cause latency, not data loss.

**AlarmClock fallback:** AlarmClock MCP (#84) is not yet implemented. Until it is, agents use a fixed-interval polling loop (configurable via `AGENT_POLL_INTERVAL_SECONDS` env var, default 60s) as a fallback. This polling loop is removed once AlarmClock is available — it is an interim mechanism, not a permanent feature.

This principle applies to **all pipeline agents** (architect, developer, reviewer, committer, etc.) and all new agents introduced by this spec.

---

## Layer Model

```
  Inputs
  ┌─────────────────────────────────┐
  │ creative agents                 │
  │ research agents                 │──→  consciousness
  │ obsidian memory                 │          │
  │ daily context (health.>)        │          │ soul.idea.pending (kick + pointer)
  │ user (user.message)             │          ▼
  └─────────────────────────────────┘     conscience
                                               │
                                    approved   │   rejected
                                    ┌──────────┤──────────┐
                                    ▼                     ▼
                                strategist           consciousness
                                    │               (reconsider)
                                    ▼
                                 Foreman
                                    │
                                    ▼
                               pipeline
                    (architect → developer → reviewer → ...)
```

---

## NATS Stream Coverage

The existing AGENTS JetStream stream covers `agent.>`, `topic.>`, and `health.>`. Soul-layer traffic uses the `soul.>` prefix. `soul.>` must be added to the AGENTS stream subject filter list alongside the existing subjects. This is a concrete implementation step — without it, conscience never receives kicks from consciousness.

User-facing communication uses two directional subjects to prevent self-consumption loops:
- `user.message.inbound` — published by Foreman/dashboard when user sends a message to consciousness; consciousness subscribes
- `user.message.outbound` — published by consciousness for display in dashboard/Foreman; consciousness does NOT subscribe to this subject

Both must be added to the AGENTS stream alongside `soul.>`.

**Stream subject update note:** Updating an existing JetStream stream's subject filter list on a live stream requires a stream update operation. If the stream cannot be updated in-place (filter change), it must be deleted and recreated — same pattern as the `ensureConsumer` delete+recreate documented for filter changes. Schedule this during a maintenance window if the stream has active consumers.

---

## Agents

### consciousness

**Role:** Strategic synthesis engine. Aggregates inputs from multiple sources, generates ideas and goals, initiates bootstrapping of missing capabilities.

**What it does:**
- Wakes up periodically (AlarmClock or fallback polling) and on NATS kicks
- Reads inputs: creative agents output, research agents, Obsidian memory, daily system context, user messages
- Synthesizes inputs into ideas — each idea written as a file in Obsidian before sending any NATS message
- Sends kick to conscience for evaluation (never sends idea content over NATS — only pointer)
- Learns from conscience rejections and user feedback — updates Obsidian accordingly
- Does **not** deal with tickets, technical implementation, or operational decisions

**Bootstrap rejection loop:** If conscience rejects ideas during initialization, consciousness reconsiders and generates revised ideas. After **3 consecutive rejections** of initialization ideas, consciousness escalates:
1. Writes `status: needs-clarification` + conflict description to `/vault/agents/consciousness/init.md`
2. Publishes escalation message to `user.message.outbound` (displayed in dashboard/Foreman chat)
3. Enters **safe idle mode** — no further ideas generated

**Safe idle mode exit:** On each AlarmClock/polling wakeup, consciousness checks `/vault/agents/consciousness/init.md` for `status: resumed` — written by the user or Foreman after the clarification is resolved. When detected, consciousness exits safe idle mode and resumes normal operation. The user triggers this by responding via dashboard, which causes Foreman to publish to `user.message.inbound` and update the init file.

**Persistence:** `/vault/agents/consciousness/` — goals, ideas, learning, daily context

**NATS subjects (consume):** `soul.idea.rejected`, `health.>`, `user.message.inbound`
**NATS subjects (produce):** `soul.idea.pending` (kick + Obsidian pointer), `user.message.outbound` (response to user/dashboard)

---

### conscience

**Role:** Values filter — mandatory gate between consciousness and the rest of the system. Evaluates **ideas and intentions**, not execution details.

**What it does:**
- Wakes up periodically (AlarmClock or fallback polling) and on NATS kicks — **conscience is pull-based like all agents**
- On each wakeup, scans `/vault/agents/consciousness/ideas/` for files in `pending_conscience` state (no `## Conscience Evaluation` section) — this recovers ideas whose NATS kick was lost
- Evaluates every pending idea against:
  1. **`/vault/agents/conscience/PRINCIPLES.md`** — immutable principles (Asimov's laws, owner duties, hardcoded ethics). This is a dedicated file, not the developer-facing `CLAUDE.md` workflow file. It is committed to the hub agent definition and never updated at runtime.
  2. **`/vault/agents/conscience/values.md`** — customizable values layer, updated via explicit user instructions and feedback
- Writes evaluation result to the idea file in Obsidian (`status: approved | rejected`, `reasoning: ...`)
- On rejection: kicks consciousness with pointer to rejection reasoning
- On approval: kicks strategist with pointer to approved idea

**Enforcement:** Strategist verifies the idea file contains `status: approved` in conscience's Obsidian section before acting. If the file is missing or not approved, strategist logs a warning and does not act. This vault-based check makes conscience bypass architecturally detectable (it leaves a missing approval record). Full cryptographic enforcement is deferred to post-GH #94 (bearer token auth).

**What it does NOT evaluate:** operational decisions (deploy strategy, batching, tooling) — those belong to strategist.

**Persistence:**
- `/vault/agents/conscience/PRINCIPLES.md` — immutable, defined at hub agent install time
- `/vault/agents/conscience/values.md` — customizable, updated by user feedback
- `/vault/agents/conscience/history.md` — rejection/approval log (append-only summary per idea; the authoritative record is the idea file itself — `history.md` is a human-readable index, not a source of truth)

**NATS subjects (consume):** `soul.idea.pending`
**NATS subjects (produce):** `soul.idea.approved`, `soul.idea.rejected`

---

### strategist

**Self-naming:** On first initialization, strategist reads `/vault/agents/strategist/name.md`. If the file exists, it uses the stored name. If not, it chooses a name based on system context ("COO" for a virtual company, "planner" for a personal assistant, etc.) and writes it to `/vault/agents/strategist/name.md`. This makes self-naming idempotent across restarts.

**Role:** Tactical layer — decides how and when to act on approved ideas. Translates strategic intentions into concrete work.

**What it does:**
- Wakes up periodically (AlarmClock or fallback polling) and checks ticketing system for pending work
- Receives approved idea kicks from conscience
- **Verification step:** reads idea file from Obsidian, confirms `status: approved` before acting
- Decides: create ticket (`create_ticket`) / schedule brainstorm / archive idea
- Calls Foreman for execution
- Does **not** decide what ideas to pursue (consciousness) or whether they are ethical (conscience)

**Persistence:** `/vault/agents/strategist/` + ticketing system (work queue, in-flight items)

**NATS subjects (consume):** `soul.idea.approved`
**NATS subjects (produce):** existing Foreman/pipeline channels

---

### Foreman

Unchanged from current implementation. Receives work from strategist and routes to the appropriate pipeline.

---

## Idea File Lifecycle

Each idea is a file in `/vault/agents/consciousness/ideas/{ideaId}.md`. Lifecycle states:

```
created → pending_conscience → approved → dispatched_to_strategist
                            → rejected → reconsidering (new ideaId) | escalated
```

**Reconsideration always creates a new idea file** with a new ideaId. The rejected idea file is never overwritten — it remains as a record of the rejected attempt. This ensures conscience's evaluation record is preserved and the bypass-detection mechanism (strategist checks for `status: approved`) remains reliable.

After conscience evaluates, it writes the result directly into the idea file:
```markdown
## Conscience Evaluation
Status: approved | rejected
Reasoning: ...
Evaluated: YYYY-MM-DD HH:MM
```

Strategist writes its action into the same file after dispatching:
```markdown
## Strategist Action
Action: ticket_created | brainstorm_scheduled | archived
Reference: TICK-0xxx
Dispatched: YYYY-MM-DD HH:MM
```

**Archival:** Ideas in terminal states (dispatched or rejected+not-reconsidered) older than 30 days are moved to `/vault/agents/consciousness/archive/` by the Memory Agent (Layer A) during its nightly run. The ideas directory does not grow unbounded.

---

## Initialization

### First run

1. **Seed** — system provides consciousness with: instance type (personal/company), owner identity, basic context
2. **Dynamic questionnaire** — consciousness asks the user what it needs to know via `user.message.outbound` (displayed in Foreman chat / dashboard). User responds via dashboard, Foreman publishes response to `user.message.inbound`. Questions are context-driven, not a fixed list
3. **Obsidian bootstrap** — consciousness writes initial goals and context to `/vault/agents/consciousness/init.md`
4. **Conscience bootstrap** — conscience reads `PRINCIPLES.md` (immutable base) + creates empty `values.md` (populated from questionnaire responses)
5. **Strategist self-naming** — reads `/vault/agents/strategist/name.md`; if absent, chooses name from context and writes it
6. **Gap analysis** — consciousness synthesizes: "what capabilities do I need to fulfill my goals?" → writes idea files → sends kicks to conscience → conscience evaluates → strategist acts. Gap-analysis ideas are subject to the same 3-consecutive-rejection escalation rule as all initialization ideas.
7. **Bootstrap rejection escalation** — if 3 consecutive ideas are rejected during init (including gap-analysis ideas), escalate to user (see consciousness bootstrap rejection loop above)

### Startup ordering

On install, agents must start in this order: **conscience → consciousness → strategist**. Conscience must be subscribed to `soul.idea.pending` before consciousness emits its first kick.

The hub team definition (`consciousness-layer`) specifies this ordering via `requires` fields in agent manifests (GH #65). If `requires`-based startup ordering is not enforced by agent-manager at runtime, consciousness must use a retry pattern: before emitting the first `soul.idea.pending` kick, consciousness verifies that conscience's NATS consumer is registered (e.g., by checking `health.conscience` in Obsidian or waiting up to 30 seconds for conscience's first health write). This retry is a fallback — `requires` enforcement is the preferred mechanism.

### Session rollover

On container restart, each agent reads its Obsidian state as the first action — no cold start. Agents then pull their work queues from the ticketing system before subscribing to NATS.

### Questionnaire is never fully complete

Consciousness can ask clarifying questions at any time when its values or context are insufficient.

---

## NATS Message Format

All soul-layer NATS messages carry only a pointer — never content:

```json
{
  "ideaId": "idea-2026-03-22-abc123",
  "path": "/vault/agents/consciousness/ideas/idea-2026-03-22-abc123.md",
  "ts": 1774162293917
}
```

---

## Heartbeats and System Awareness

Each agent writes to its own health file (`/vault/agents/{agentId}/health.md`) on each wakeup — one file per agent prevents write contention. Agents also publish to `health.{agentId}` on NATS.

```markdown
# consciousness — health
Last wakeup: 2026-03-22 14:30
Ideas generated today: 3
Ideas approved: 2 / rejected: 1
Inputs consumed: creative(2), research(1), memory scan(1)
Next alarm: 14:45
```

Consciousness reads `health.>` events as part of its daily context synthesis.

---

## Hub Agent Definitions (English names)

| Hub agent name | Czech concept | Role |
|----------------|--------------|------|
| `consciousness` | vědomí | Strategic synthesis |
| `conscience` | svědomí | Values filter |
| `strategist` | plánovač | Tactical execution (self-renames at init) |

Hub team: `consciousness-layer` — installs all three agents with startup ordering constraint (conscience first).

`conscience` agent definition includes `/vault/agents/conscience/PRINCIPLES.md` committed in the hub repo. This file contains Asimov's laws and owner duty principles — it is the immutable ethics base.

---

## System-Wide Pipeline Changes

The pull-over-push principle requires updates to all existing pipeline agents. These changes are additive — existing JetStream consumers are **retained** alongside the new AlarmClock/polling loop. Both paths can trigger work; deduplication is handled by the ticketing system (agent calls `update_ticket(status: in_progress)` before starting — second caller sees the ticket already claimed and skips it).

| Agent | Change |
|-------|--------|
| `sd-architect` | Add AlarmClock/fallback polling, pull `list_tickets` on wakeup, claim tickets via `update_ticket` before processing |
| `sd-developer` | Same |
| `sd-reviewer` | Same |
| `sd-committer` | Same |
| `sd-pm` | Already addressed in sd-pm spec (2026-03-22) |

**Ack strategy:** JetStream messages continue to be acked after processing (existing behavior). The polling loop does not ack NATS messages — it reads from the ticketing system directly. No change to ack-before-completion behavior (remains a known gap per the existing issues).

AlarmClock interval adapts to queue depth — busy queue → short interval, idle → long interval.

---

## What This Is Not

- **Not a replacement for Foreman** — strategist calls Foreman, does not replace it
- **Not a monitoring system** — heartbeats are for context synthesis; the existing health monitor is unchanged
- **Not instance-specific** — "Bohumil" is one possible initialization context, not a hardcoded concept
- **Not a rigid hierarchy** — consciousness can receive user input directly via `user.message.inbound` and respond via `user.message.outbound`

---

## Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| AlarmClock MCP (#84) | Planned, not implemented | Interim: fixed-interval polling loop until #84 ships |
| `soul.>` added to AGENTS JetStream stream | New | Add alongside existing `agent.>`, `topic.>`, `health.>` |
| `user.message.inbound` + `user.message.outbound` added to AGENTS stream | New | `inbound`: Foreman/dashboard → consciousness; `outbound`: consciousness → dashboard/Foreman. Both required. |
| `conscience/PRINCIPLES.md` in hub repo | New | Immutable ethics file committed to hub agent definition |
| `create_ticket` MCP tool for strategist | Existing | Must be in strategist's `allowedTools` |
| `list_tickets`, `update_ticket` MCP tools | Existing | All three agents need access |
| Obsidian vault mounted in agent containers | Existing (`HOST_OBSIDIAN_VAULT_PATH`) | |
| Hub team: `consciousness-layer` with startup ordering | New | conscience starts before consciousness |
| Pipeline agent polling loop adoption | New | Affects all sd-* agents; additive to existing JetStream consumers |
