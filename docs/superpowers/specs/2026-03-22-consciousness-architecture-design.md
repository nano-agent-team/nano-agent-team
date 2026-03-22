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
  │ user                            │          ▼
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

## Agents

### consciousness

**Role:** Strategic synthesis engine. Aggregates inputs from multiple sources, generates ideas and goals, initiates bootstrapping of missing capabilities.

**What it does:**
- Wakes up periodically (AlarmClock) and on NATS kicks
- Reads inputs: creative agents output, research agents, Obsidian memory, daily system context, user messages
- Synthesizes inputs into ideas — each idea written as a file in Obsidian
- Sends kick to conscience for evaluation (never sends idea content over NATS — only pointer)
- Learns from conscience rejections and user feedback — updates Obsidian accordingly
- Does **not** deal with tickets, technical implementation, or operational decisions

**Persistence:** `/vault/Agents/consciousness/` — goals, ideas, learning, daily context

**NATS subjects (consume):** `soul.idea.rejected`, `health.>`, `user.message` (kick only)
**NATS subjects (produce):** `soul.idea.pending` (kick + Obsidian pointer)

---

### conscience

**Role:** Values filter — mandatory gate between consciousness and the rest of the system. Evaluates **ideas and intentions**, not execution details.

**What it does:**
- Evaluates every idea from consciousness against:
  1. **CLAUDE.md** — immutable principles (Asimov's laws, owner duties, hardcoded ethics)
  2. **Obsidian** — customizable values layer, updated via user feedback and explicit instructions
- Returns `approved` or `rejected` with reasoning written to Obsidian
- On rejection: kicks consciousness with pointer to rejection reasoning
- On approval: kicks strategist with pointer to approved idea

**What it does NOT evaluate:** operational decisions (deploy strategy, batching, tooling choices) — those belong to strategist.

**Persistence:**
- `CLAUDE.md` — immutable principles, never updated by runtime feedback
- `/vault/Agents/conscience/` — customizable values, rejection history, learning

**NATS subjects (consume):** `soul.idea.pending`
**NATS subjects (produce):** `soul.idea.approved`, `soul.idea.rejected`

---

### strategist

**Self-naming:** On first initialization, strategist names itself based on system context — "COO" for a virtual company, "planner" for a personal assistant, etc. The name is stored in Obsidian and used in all subsequent communication.

**Role:** Tactical layer — decides how and when to act on approved ideas. Translates strategic intentions into concrete work.

**What it does:**
- Wakes up periodically (AlarmClock) and checks ticketing system for pending work
- Receives approved ideas from conscience (kick + Obsidian pointer)
- Decides: create ticket / schedule brainstorm / archive idea
- Calls Foreman for execution
- Manages dependencies between ideas in flight
- Does **not** decide what ideas to pursue (that is consciousness) or whether they are ethical (that is conscience)

**Persistence:** Obsidian (`/vault/Agents/strategist/`) + ticketing system (work queue, in-flight items)

**NATS subjects (consume):** `soul.idea.approved`
**NATS subjects (produce):** calls Foreman via existing channels

---

### Foreman

Unchanged from current implementation. Receives work from strategist and routes to the appropriate pipeline.

---

## Initialization

### First run

1. **Seed** — system provides consciousness with: instance type (personal/company), owner identity, basic context
2. **Dynamic questionnaire** — consciousness asks the user what it needs to know. Questions are context-driven, not a fixed list:
   - Personal assistant instance: family members, daily rhythm, values, communication preferences
   - Virtual company instance: mission, team structure, strategic priorities, constraints
3. **Obsidian bootstrap** — consciousness writes initial goals and context to `/vault/Agents/consciousness/init.md`
4. **Conscience bootstrap** — conscience reads CLAUDE.md (immutable base) + Obsidian values from questionnaire
5. **Strategist self-naming** — strategist reads system context, chooses its own operational name, writes it to Obsidian
6. **Gap analysis** — consciousness immediately synthesizes: "what capabilities do I need to fulfill my goals?" → first ideas generated → conscience evaluates → strategist acts

### Session rollover

On container restart, each agent reads its Obsidian state as the first action — no cold start. Agents then pull their work queues from the ticketing system before subscribing to NATS.

### Questionnaire is never fully complete

Consciousness can ask clarifying questions at any time when it encounters a situation where its values or context are insufficient. The questionnaire is an ongoing conversation, not a one-time form.

---

## NATS Message Format

All soul-layer NATS messages carry only a pointer — never content:

```json
{
  "ideaId": "idea-2026-03-22-abc123",
  "path": "/vault/Agents/consciousness/ideas/idea-2026-03-22-abc123.md",
  "ts": 1774162293917
}
```

Receiving agents read the full idea from Obsidian. This keeps NATS messages small, makes ideas human-readable in the vault, and means no data is lost if a NATS message is dropped.

---

## Heartbeats and System Awareness

Each agent writes a health entry to Obsidian + publishes to `health.{agentId}` on each wakeup:

```markdown
# consciousness — health
Last wakeup: 2026-03-22 14:30
Ideas generated today: 3
Ideas approved: 2 / rejected: 1
Inputs consumed: creative(2), research(1), memory scan(1)
Next alarm: 14:45
```

Consciousness reads `health.>` events as part of its daily context synthesis — it knows what the whole system did today.

---

## Hub Agent Definitions (English names)

Agents are defined in the hub repo with English names:

| Hub agent name | Czech concept | Role |
|----------------|--------------|------|
| `consciousness` | vědomí | Strategic synthesis |
| `conscience` | svědomí | Values filter |
| `strategist` | plánovač | Tactical execution (self-renames at init) |

These agents are installable as a team: `consciousness-layer` hub team installs all three plus configures their NATS subjects and Obsidian paths.

---

## System-Wide Pipeline Changes

The NATS-as-kick principle requires updates to all existing pipeline agents:

| Agent | Change |
|-------|--------|
| `sd-architect` | Add AlarmClock, pull tickets from ticketing system on wakeup |
| `sd-developer` | Same — NATS task message is now an optimization, not required |
| `sd-reviewer` | Same |
| `sd-committer` | Same |
| `sd-pm` | Already addressed in sd-pm persistent agent spec (2026-03-22) |

Each pipeline agent's AlarmClock interval should adapt to queue depth — busy queue → short interval, idle → long interval. This mirrors the rolling alarm pattern from the sd-pm spec.

---

## What This Is Not

- **Not a replacement for Foreman** — Foreman remains the operational router; strategist calls Foreman, does not replace it
- **Not a monitoring system** — heartbeats are for consciousness's context synthesis, not for alerting; the existing health monitor remains unchanged
- **Not a rigid hierarchy** — consciousness can receive user input directly (urgent messages bypass the normal synthesis cycle); conscience evaluates the urgency and approves fast-path if appropriate
- **Not instance-specific** — the architecture works for any instance type; "Bohumil" is one possible initialization context, not a hardcoded concept

---

## Dependencies

| Dependency | Status |
|-----------|--------|
| AlarmClock MCP (#84) | Planned, not yet implemented — required for all agents in this spec |
| Obsidian vault mounted in agent containers | Existing (`HOST_OBSIDIAN_VAULT_PATH`) |
| Ticketing system MCP tools (`list_tickets`, `update_ticket`) | Existing |
| Hub team definition: `consciousness-layer` | New |
| Pipeline agent AlarmClock adoption | New — affects all sd-* agents |
