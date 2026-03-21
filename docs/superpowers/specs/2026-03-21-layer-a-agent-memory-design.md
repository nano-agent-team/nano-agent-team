# Layer A — Agent Memory & Knowledge Curation

**Date:** 2026-03-21
**Status:** Draft
**GH Issue:** TBD

---

## Overview

Layer A gives every agent persistent memory between sessions. It has two components:

1. **Agent Self-Reflect** — each agent writes a structured session note to the shared Obsidian vault at the end of every task.
2. **Memory Agent** — a daily cron hub agent that reads the entire vault, reorganizes knowledge, identifies cross-agent patterns, and creates idea tickets for recurring gaps.

---

## Component 1: Agent Self-Reflect

### When

At the end of every task — after the agent updates the ticket status to `done` or `committed`. The reflect step is the last action before the agent becomes idle.

For ephemeral agents (running with `workspace_source: 'ticket'`), the reflect write happens before the agent process exits. If the write fails (missing mount, disk full), it is silently skipped — the task result is not affected. No retry.

### What agents write

Each agent writes a session note in markdown to the Obsidian vault:

```markdown
---
date: YYYY-MM-DD HH:MM
agent: {agentId}
task: {taskId}
status: done | failed | blocked
---

## Summary
What was done. What was delivered.

## Findings
Technical observations, decisions made, gotchas encountered.

## Missing
Tools, information, capabilities, or context that would have helped.
(These become candidates for idea tickets.)

## Speed-ups
Concrete things that would make this work faster next time.
```

### Where

Agents always write to the container-internal path `/vault`:

```
/vault/Agents/{agentId}/YYYY-MM-DD-{taskId}.md
```

Example: `/vault/Agents/sd-developer/2026-03-21-TICK-0042.md`

`CLAUDE.md` instructions always reference `/vault` — not the host path.

### How agents access the vault

AgentManager mounts the Obsidian vault into each agent container when `HOST_OBSIDIAN_VAULT_PATH` is set:

```yaml
volumes:
  - ${HOST_OBSIDIAN_VAULT_PATH}:/vault
```

Two env vars (same pattern as `HOST_DATA_DIR` / `HOST_CLAUDE_DIR`):

| Env var | Used by | Value |
|---------|---------|-------|
| `HOST_OBSIDIAN_VAULT_PATH` | AgentManager (Docker bind source) | macOS host path, e.g. `/Users/rpridal/Documents/Claude-Brain` |
| *(none)* | Agents | Always `/vault` (fixed container-internal path) |

`HOST_OBSIDIAN_VAULT_PATH` must be added to both `env = [` blocks in `agent-manager.ts` (start + rollover/restart paths).

If `HOST_OBSIDIAN_VAULT_PATH` is unset, the vault is not mounted, agents skip the reflect step silently.

### Triggering the reflect

Agents are instructed in their `CLAUDE.md` to perform reflect as the final step of every task. No new NATS topic is needed — it is a local write action, not an event.

Memory Agent does **not** need to be notified. It discovers new notes on its next cron run.

---

## Component 2: Memory Agent

### Identity

Hub agent: `hub/agents/memory-agent/`
Base image: `nano-agent:latest`
Schedule: cron, once per day (default `0 3 * * *`, configurable via `MEMORY_AGENT_CRON` env var in the system config)

The Memory Agent follows the same self-reflect rules as every other agent — it writes its own session note at the end of each run.

### What it does

**1. Scan & ingest**

Reads all session notes written since the last run. Last-run timestamp is persisted as a single line in `/vault/.memory-agent-last-run` (ISO 8601). On first run, processes all notes.

**2. Organize**
- Merges notes about the same topic into consolidated project notes (`/vault/Projects/{topic}.md`)
- Deduplicates observations that appear in multiple agent notes
- Adds cross-links (`[[wikilinks]]`) between related notes and tickets

**3. Pattern detection**

Identifies "missing" and "speed-up" observations that appear **2 or more times** independently — meaning from at least 2 different agents, OR from the same agent on at least 2 different tasks (not the same task twice). Single one-off observations are recorded in the vault but not promoted to tickets.

**4. Ticket creation**

Before creating a ticket, Memory Agent calls `list_tickets` and uses its own judgment to identify existing tickets with the same or very similar intent. If a match is found, it updates the existing ticket's description rather than creating a duplicate.

For new patterns:

```json
{
  "type": "idea",
  "status": "new",
  "priority": "low",
  "title": "...",
  "description": "...",
  "labels": ["source:memory-agent"],
  "metadata": {
    "reported_by": ["sd-developer", "sd-reviewer"],
    "occurrences": 3,
    "first_seen": "2026-03-19",
    "last_seen": "2026-03-21"
  }
}
```

`status: "new"` with `priority: "low"` keeps these tickets out of the active pipeline until a PM agent promotes them.

**5. Self-reflect**
Writes its own session note: what was reorganized, what patterns were found, what tickets were created.

### MCP tools available to Memory Agent

| Tool | Purpose |
|------|---------|
| `create_ticket` | Create idea tickets from patterns |
| `list_tickets` | Deduplicate before creating |
| Filesystem (`/vault`) | Read and write Obsidian vault |

Memory Agent does **not** have access to agent management tools — it is read/write on knowledge only.

### Manifest (memory-agent)

```json
{
  "id": "memory-agent",
  "schedule": "0 3 * * *",
  "volumes": [
    "${HOST_OBSIDIAN_VAULT_PATH}:/vault"
  ],
  "mcp_permissions": {
    "tickets": ["create_ticket", "list_tickets"]
  },
  "allowedTools": ["mcp__tickets__*"]
}
```

AgentManager must perform env var expansion on `volumes` entries (substituting `${HOST_OBSIDIAN_VAULT_PATH}` from the control-plane environment) before constructing the Docker bind mount — JSON does not perform this substitution natively. `MEMORY_AGENT_CRON` is a control-plane env var read by `CronScheduler`; it is not passed into the agent container.

---

## Cron trigger infrastructure

The `schedule` field in `AgentManifest` is new and requires three control-plane changes:

**1. New field in AgentManifest schema**
Add optional `schedule?: string` (cron expression). Validated with a cron parser at load time.

**2. Third agent lifecycle mode in AgentManager**
Current modes: persistent (kept alive, restarted on crash) and ephemeral (run-once, removed after exit). Cron agents are a third mode:
- Not started at boot
- Started by the cron scheduler at the configured interval
- Container exits cleanly after the run — AgentManager must NOT restart it (distinguish clean exit from crash via exit code 0)
- Next run starts a fresh container

**3. Cron scheduler in control plane**
A `CronScheduler` service in the control plane (e.g. using `node-cron` package) reads all installed agents with a `schedule` field and fires them at the configured times. This is separate from the existing `AlarmClock` (which handles one-off delays, not recurring cron expressions).

---

## Obsidian Vault Structure

```
~/Documents/Claude-Brain/
├── Daily/                    # Claude Code session notes (existing)
├── Projects/                 # Consolidated topic notes (curated by Memory Agent)
├── Agents/
│   ├── sd-developer/         # Per-task session notes from sd-developer
│   ├── sd-reviewer/
│   ├── sd-architect/
│   ├── memory-agent/         # Memory Agent's own session notes
│   └── foreman/
├── Feedback/                 # Architecture decisions, gotchas (existing)
└── .memory-agent-last-run    # ISO timestamp, written by Memory Agent
```

The `Agents/` subtree and `.memory-agent-last-run` are new. All other paths are existing structure.

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `HOST_OBSIDIAN_VAULT_PATH` | *(unset)* | macOS host path to Obsidian vault. Feature disabled if unset. |
| `MEMORY_AGENT_CRON` | `0 3 * * *` | Cron schedule for Memory Agent (3am daily) |

Pattern threshold (min 2 independent occurrences to promote to a ticket) is a constant in the Memory Agent's CLAUDE.md. It is not a runtime env var.

---

## What this is not

- **Not a per-task event** — no `topic.agent.reflect` NATS message. Reflect is a local write.
- **Not real-time** — patterns are detected daily, not per-task.
- **Not a replacement for sd-pm** — Memory Agent creates `new/low` tickets only. Promotion and prioritization remain with PM agent.
- **Not a Layer B** — proactive feedback loops (agent feedback → Creative Agent → tickets) are Layer B and out of scope here.

---

## Dependencies

| Dependency | Status |
|-----------|--------|
| `create_ticket` MCP tool | Exists |
| `list_tickets` MCP tool | Exists |
| `schedule` field in AgentManifest | New — requires `CronScheduler` service + third lifecycle mode in AgentManager |
| `node-cron` package | New dependency |
| `HOST_OBSIDIAN_VAULT_PATH` env injection in AgentManager (both env blocks) | New |
| Vault volume mount in agent containers | New |
