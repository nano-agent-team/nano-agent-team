# Agent Teams: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS Integration

**Date:** 2026-03-22
**Status:** Draft
**GH Issue:** TBD

---

## Overview

Enable all nano-agent-team agents to use Claude Code's native agent teams feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). Each agent running inside a Docker container can autonomously decide to spawn a team of sub-instances (teammates) for complex tickets, while simple tickets are handled by a single session as before.

---

## Goals

- All agents can use agent teams when the LLM determines parallel work adds value
- Teammates inherit the same MCP servers (context MCP, tickets MCP, obsidian, etc.) as the lead
- No changes to the NATS pipeline, ticket lifecycle, or after-work hook
- Minimal changes to existing code — env vars + settings.json injection + Dockerfile

---

## Background: How Agent Teams Work

Agent teams are a Claude Code feature that lets one session (the **team lead**) coordinate multiple independent Claude Code instances (**teammates**):

| Component | Role |
|-----------|------|
| **Team lead** | The main `query()` session; creates the team, spawns teammates, synthesizes results |
| **Teammates** | Separate Claude Code sessions; each has its own context window |
| **Shared task list** | File-based task coordination with file locking (no race conditions) |
| **Mailbox** | Direct inter-agent messaging (`SendMessage`); teammates can talk to each other |

**Key difference from subagents:** Teammates communicate directly with each other, not only through the lead.

**In-process mode:** All teammates run inside the same process (no tmux required). Correct mode for containerised agents.

**Filesystem:** All teammates in in-process mode share the same container filesystem. The lead must assign file ownership per task to prevent conflicts.

**Token cost:** Scales linearly with teammate count (~3x for a 3-teammate team). The LLM decides when the benefit justifies the cost.

---

## Architecture

### Runtime Flow

```
NATS/EPHEMERAL → agent-runner
  │
  ├─ Write /workspace/.claude/settings.json
  │   (MCP servers + agent teams env vars)
  │
  └─ query() → Lead Claude Code session
       │
       ├─ Reads CLAUDE.md + .claude/settings.json
       ├─ Receives ticket as prompt
       │
       ├─ [simple ticket] → works alone → result
       │
       └─ [complex ticket] → spawns team
            TeamCreate("ticket-{id}")
            TaskCreate × N  (each with explicit file ownership)
            Task × N        (spawn teammates)
            teammates work in parallel on /workspace
            teammates mark tasks completed
            lead synthesises → TeamDelete
            → result
  │
  └─ after-work hook: ticket → done  (unchanged)
```

### MCP Inheritance Problem and Solution

In nano-agent-team, MCP servers are passed programmatically via `sdkOptions.mcpServers` in `query()`. Teammates are separate Claude Code processes — they cannot access runtime objects from their parent. They load MCP config from files.

**Solution:** agent-runner writes `.claude/settings.json` to the workspace before `query()`. Teammates spawned in the same `cwd` load this file automatically and inherit all MCP servers.

---

## Changes

### 1. `agent-manager.ts` — both `env =` blocks

Add to all agents (both start path and rollover/restart path):

```
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
CLAUDE_CODE_TEAMMATE_MODE=in-process
```

> Both env blocks must be updated — the same two-block pattern as `HOST_DATA_DIR` and `HOST_OBSIDIAN_VAULT_PATH`. Missing one block is a known silent failure mode.

### 2. `container/agent-runner/src/providers/claude.ts`

Before calling `query()`, write the settings file so teammates can inherit MCP config:

```ts
// Write .claude/settings.json so spawned teammates inherit MCP servers
const settingsDir = path.join(options.cwd, '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({
  mcpServers: options.mcpServers ?? {},
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_TEAMMATE_MODE: 'in-process',
  },
}, null, 2), 'utf8');
```

### 3. `container/agent-runner/src/index.ts` — `allowedTools`

Add agent team tools to the default tool list in both the NATS loop path and the ephemeral path:

```ts
const AGENT_TEAM_TOOLS = [
  'TeamCreate', 'TaskCreate', 'TaskUpdate', 'TaskList',
  'Task', 'SendMessage', 'TeamDelete',
];

const defaultTools = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch',
  ...mcpToolPatterns,
  ...AGENT_TEAM_TOOLS,
];
```

### 4. `container/Dockerfile`

Create workspace directories for team state:

```dockerfile
RUN mkdir -p /workspace/teams /workspace/tasks
```

Team state (`~/.claude/teams/` and `~/.claude/tasks/`) is redirected to `/workspace/teams/` and `/workspace/tasks/` via env vars `CLAUDE_TEAMS_DIR` and `CLAUDE_TASKS_DIR`. This makes team state persist across session restarts (same bind-mount as `sessions/session_id`).

---

## CLAUDE.md Considerations

Teammates load the agent's `CLAUDE.md` from `/workspace/CLAUDE.md` automatically (same `cwd`). The agent's identity (e.g. "you are sd-developer") is visible to all teammates.

The lead must override this in spawn prompts with task-specific roles:

```
Spawn a teammate with prompt: "You are a test writer. Your only job is to write
unit tests for src/auth/login.ts. Do not modify any other files."
```

No changes to existing `CLAUDE.md` files are required. The spawn prompt takes precedence over the shared identity.

---

## File Conflict Prevention

All teammates share `/workspace` filesystem. The lead is responsible for assigning file ownership in task descriptions:

- Each task must specify which files/directories the teammate owns
- Tasks must explicitly state which files to avoid
- The lead should create tasks with non-overlapping file sets

Example task description:
```
Implement src/auth/login.ts and src/auth/logout.ts.
Do NOT modify any other files. Do NOT write tests.
```

---

## What This Is Not

- **Not a change to the pipeline** — NATS routing, scrum-master, ticket lifecycle unchanged
- **Not a change to the after-work hook** — teammates complete inside `query()`, hook fires normally after
- **Not forced** — agents only use teams when the LLM decides the complexity warrants it
- **Not per-manifest opt-in** — feature is available to all agents; LLM decides when to use it

---

## Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` feature | Available in Claude Code v2.1.32+ | Verify version in container |
| Both `env =` blocks in `agent-manager.ts` | Existing pattern | See `Feedback/agent-manager-dual-env-blocks.md` |
| `/workspace` bind mount | Existing | Team state dirs added to existing mount |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| LLM over-uses teams on simple tickets | Agents use better/larger models (sonnet+); haiku agents unlikely to benefit |
| Teammates write to same files | Lead's spawn prompts must include explicit file ownership |
| `.claude/settings.json` overwritten by other tooling | Write only before `query()`, not at startup; use merge if file exists |
| Team state accumulates if TeamDelete is not called | Workspace is recreated per ephemeral ticket — stale state auto-cleared |
