# Layer C — CEO/Brain Agent

**Date:** 2026-03-21
**Status:** Superseded by `2026-03-22-consciousness-architecture-design.md` (GH #102)
**GH Issue:** N/A

> **Note:** The consciousness architecture spec (GH #102) covers all responsibilities of this agent in a more complete form: always-on instead of weekly cron, conscience as a dedicated values-gate agent instead of the 2-approval adaptive autonomy rule, direct user channel instead of Foreman-as-intermediary, and idea lifecycle tracking in Obsidian instead of pending.md. GH #86 (`send_foreman_message`) and GH #87 (`list_agents`) remain valid as separate MCP tool implementation tickets — they are needed by the strategist agent.

---

## Overview

The CEO/Brain agent is the strategic layer of the nano-agent-team system. Unlike Foreman (reactive — receives commands, executes them with many tools), the CEO has very few tools but acts on its own initiative. Its primary capability is proposing new directions and bootstrapping the resources needed to pursue them.

The CEO does not implement anything directly. It identifies what the system needs, delegates acquisition of missing capabilities to Foreman, and then delegates the work itself through the resulting agents and teams.

---

## Responsibilities

**What CEO does:**
- Reads system context (vault, open tickets, installed agents, recent patterns)
- Identifies missing capabilities or strategic opportunities
- Bootstraps new capabilities through Foreman when needed (Phase 2 — see below)
- Communicates proposals and status to the user via Foreman chat

**What CEO does not do:**
- Does not install agents directly
- Does not write code
- Does not manage tickets or prioritize the pipeline
- Does not replace Foreman for reactive/user-requested tasks

---

## Self-bootstrapping pattern (Phase 2)

The CEO's most distinctive long-term capability: when it identifies a needed capability that does not exist, it commissions its own development through the existing pipeline.

```
CEO: "I need to read emails"
  → Foreman: "no mail agent in hub"
  → CEO: "create a dev team"
  → Foreman: spawns dev team
  → CEO → dev team: "build a mail reader/sender agent"
  → pipeline: SD-PM → Architect → Developer → Reviewer → Committer
  → deploy → CEO now has mail capability
```

**This is a Phase 2 capability.** It depends on `send_foreman_message` (bidirectional), the full self-dev pipeline, and a vault-based pending state mechanism. Phase 1 covers vault reading, weekly assessment, and one-way proposals to the user.

**Pending state tracking:** When CEO commissions work via Foreman, it writes a pending entry to `/vault/Agents/ceo/pending.md`:

```markdown
## 2026-03-21 — mail agent
Status: commissioned
Commissioned: 2026-03-21
Foreman message: "Create a dev team to build a mail reader/sender agent"
Check on: next weekly run
```

On each subsequent weekly run, CEO checks `pending.md` first. If the commissioned work is complete (agent appears in `list_agents`), it marks the entry done. If not, it waits another cycle. This prevents re-commissioning the same work.

---

## Triggers

CEO activates on two triggers:

**1. Cron (weekly)**
Once per week the CEO reviews the full system state: installed agents, open tickets, vault patterns, recent agent session notes. It reflects on what is missing or what direction the system should pursue.

**2. Memory Agent signal**
When the Memory Agent identifies a recurring pattern (Layer A), instead of publishing to NATS (which would be lost while CEO is not running), it writes a signal file to the vault:

```
/vault/Signals/YYYY-MM-DD-{topic}.md
```

On each weekly run, CEO reads all unprocessed signal files (those without a `processed: true` frontmatter flag), evaluates them, and marks them processed. This is consistent with the vault-first communication pattern already used by the Memory Agent and avoids NATS delivery problems with cron containers.

CEO may choose to act, defer, or ignore each signal. The decision and reasoning are written to the session note.

---

## Adaptive autonomy

The CEO does not have a fixed permission level set at install time. Instead, it calibrates its own autonomy through interaction with the user over time.

### Decision type taxonomy

The CEO categorizes every significant decision into one of these types:

| Decision type | Example | Default (no precedent) |
|--------------|---------|----------------------|
| `create-dev-team` | Spawn a new dev team | Propose |
| `commission-new-agent` | Ask dev team to build X | Propose |
| `create-ticket` | Open a new idea ticket | Propose |
| `install-from-hub` | Install an existing hub agent | Propose |
| `strategic-direction` | Pursue a new project area | Propose |

All types default to "propose" until the user has approved the same type at least twice. After 2 approvals of the same type, CEO acts autonomously for future decisions of that type (still reporting the action afterwards).

### Autonomy log schema

Stored in `/vault/Agents/ceo/autonomy-log.md`. Each entry:

```markdown
---
date: 2026-03-21
decision_type: create-dev-team
description: Create dev team to build mail agent
user_response: approved | rejected | modified
autonomous_next: false
---
Rule: user approved creation of dev team for a missing utility agent.
```

CEO reads all entries at the start of each run. For each pending decision:
1. Find entries with matching `decision_type`
2. Count approvals — if ≥ 2, set `autonomous_next: true` in the log and act autonomously going forward
3. If unsure (no precedent or <2 approvals), present proposal via Foreman chat and wait for next run to check response

### Starting state

New CEO installation starts in **supervised** mode — all significant decisions (any `decision_type` from the table above) are proposed to the user before execution. Vault reads, status checks, and `list_*` calls are always autonomous.

---

## Tools

The CEO has intentionally minimal tooling. It works through Foreman, not directly.

| Tool | Purpose |
|------|---------|
| `send_foreman_message` | Delegate tasks to Foreman, report to user (Phase 2: bidirectional) |
| `list_tickets` | Read current pipeline state |
| `list_agents` | Read currently installed agents |
| `list_hub_agents` | Check hub catalog for available agents |
| Filesystem (`/vault`) | Read system context, write decisions and autonomy log |

CEO never calls `install_agent`, `create_ticket`, or agent management tools directly. Everything goes through Foreman.

**`send_foreman_message` behavior (Phase 1):** Creates a new Foreman session with the message content. Fire-and-forget — CEO does not wait for a response within the same run. Foreman responds to the user in chat. On the next weekly run, CEO can read vault notes or ask Foreman for status.

---

## Foreman relationship

Foreman and CEO are complementary, not competing:

| | Foreman | CEO |
|--|---------|-----|
| **Trigger** | User command | Own initiative |
| **Tools** | Many (install, build, manage) | Few (communicate, read) |
| **Scope** | Execute what is asked | Decide what to pursue |
| **Memory** | Session-only | Persistent (vault) |

CEO sends natural language instructions to Foreman via `send_foreman_message`. In Phase 1 this is one-way — Foreman responds to the user in chat; CEO tracks outcomes via vault on the next run.

---

## Manifest

```json
{
  "id": "ceo",
  "schedule": "0 9 * * 1",
  "volumes": [
    "${HOST_OBSIDIAN_VAULT_PATH}:/vault"
  ],
  "mcp_permissions": {
    "tickets": ["list_tickets"],
    "management": ["send_foreman_message", "list_hub_agents", "list_agents"]
  },
  "allowedTools": ["mcp__tickets__list_tickets", "mcp__management__send_foreman_message", "mcp__management__list_hub_agents", "mcp__management__list_agents"]
}
```

Schedule: Monday 9am — weekly strategic review.

`MEMORY_AGENT_CRON` applies to memory-agent; `schedule` in CEO manifest is not an env var override — it is set at install time and can be changed via `save_agent_definition`.

---

## CEO session flow

Each CEO run follows this structure:

1. **Read context** — vault (recent agent notes, autonomy log, pending.md), open tickets, installed agents (`list_agents`, `list_hub_agents`)
2. **Read signals** — scan `/vault/Signals/` for unprocessed signal files from Memory Agent
3. **Assess** — what is missing, what opportunity exists, what pattern repeats
4. **Decide** — for each identified item: check autonomy log → act autonomously or propose to user
5. **Execute** — send instructions to Foreman for autonomous items; write proposals to vault for supervised items
6. **Mark signals** — set `processed: true` in each signal file that was evaluated
7. **Reflect** — write session note to vault, update autonomy log

---

## Vault structure

```
/vault/Agents/ceo/
├── autonomy-log.md           ← structured decision precedents
├── pending.md                ← commissioned work awaiting completion
├── YYYY-MM-DD-weekly.md      ← weekly session notes
└── YYYY-MM-DD-signal-*.md   ← notes for signal-triggered content

/vault/Signals/
└── YYYY-MM-DD-{topic}.md    ← written by Memory Agent, read by CEO
```

---

## What this is not

- **Not a replacement for the user** — the CEO advises and proposes; it does not override explicit user preferences
- **Not an autonomous PM** — the CEO does not manage the ticket pipeline or assign work to existing agents
- **Not Layer B** — external trend/inspiration gathering is Layer B (Creative Agent + Trend Watcher). CEO acts on what Layer B surfaces, it does not gather it.
- **Not always-on** — CEO runs on a weekly cron schedule only

---

## Dependencies

| Dependency | Status |
|-----------|--------|
| Layer A — vault + Memory Agent signal files | Spec done, not implemented |
| `schedule` field in AgentManifest + CronScheduler | nano-agent-team #84 |
| `HOST_OBSIDIAN_VAULT_PATH` vault mount | nano-agent-team #85 |
| `send_foreman_message` MCP tool (fire-and-forget) | New — Foreman must expose this |
| `list_hub_agents` MCP tool | Exists in mcp-gateway.ts |
| `list_agents` MCP tool | New — management MCP server must expose this |
| `/vault/Signals/` convention | New — Memory Agent spec must be updated to write signal files |

---

## Open questions

- **CEO identity**: Does the user interact with CEO directly via its own chat session, or always through Foreman as intermediary?
- **Multi-instance**: If multiple nano-agent-team instances run (different projects), does each have its own CEO with its own vault subtree?
