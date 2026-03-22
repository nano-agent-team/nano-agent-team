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
- Minimal changes to existing code — env vars + settings.json injection + allowedTools

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

**Team state storage:** Team config (`~/.claude/teams/`) and task list (`~/.claude/tasks/`) are stored in the container's home dir. For ephemeral agents this is per-container and is cleaned up naturally on container exit. For persistent agents it persists across messages but is lost on container restart (acceptable — team state is transient working memory, not source of truth).

---

## Architecture

### Runtime Flow

```
NATS/EPHEMERAL → agent-runner
  │
  ├─ Write /workspace/.claude/settings.json
  │   (MCP servers so teammates can inherit them)
  │
  └─ query() → Lead Claude Code session
       │
       ├─ Reads CLAUDE.md + .claude/settings.json (project scope)
       ├─ Receives ticket as prompt
       │
       ├─ [simple ticket] → works alone → result
       │
       └─ [complex ticket] → spawns team
            TeamCreate("ticket-{id}")
            TaskCreate × N  (each with explicit file ownership)
            Task × N        (spawn teammates in-process)
            teammates work in parallel on /workspace
            teammates mark tasks completed
            lead synthesises → TeamDelete
            → result
  │
  └─ after-work hook: ticket → done  (unchanged)
```

### MCP Inheritance: Problem and Solution

In nano-agent-team, MCP servers are passed programmatically via `sdkOptions.mcpServers` in `query()`. Teammates are separate Claude Code processes — they cannot access runtime objects from their parent. They load MCP config from files.

**Solution:** agent-runner writes `.claude/settings.json` to the workspace before `query()`. Teammates spawned in the same `cwd` load this file automatically (project-scope settings) and inherit all MCP servers.

**Proxy mode interaction:** In proxy mode, the host's `~/.claude/settings.json` is bind-mounted as user-scope settings at `/home/agent/.claude/settings.json`. The project-scope file written to `/workspace/.claude/settings.json` is a different file at a different path. Claude Code merges both — project-scope `mcpServers` and user-scope `mcpServers` — with no collision. There is no conflict between the two files.

---

## Changes

### 1. `src/agent-manager.ts` — `buildAgentEnvAndBinds()` (line 1012, single function)

Add to the `env` array inside `buildAgentEnvAndBinds()` (function signature at line 933, env array starts at line 1012) — this single function is called by all three agent start paths (persistent line 310, ephemeral line 671, rollover line 839). No other location needs updating.

```ts
// Agent teams: enable native Claude Code multi-agent coordination
'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
```

Add alongside the existing `CONTEXT_MODE` and `PRELOAD_SKILLS` conditional vars (lines 1029–1031). This var is unconditional (all agents get it) — the LLM decides when to use teams.

> **Note:** `CLAUDE_CODE_TEAMMATE_MODE` is NOT a real env var. In-process mode is configured via `teammateMode` in `settings.json` (see Step 2 below). The default "auto" mode already uses in-process when tmux is not available, so this is handled by the settings.json write.

> **Note:** Only one change needed — `buildAgentEnvAndBinds()` is the single source of env vars for all agent lifecycle paths. The historical "dual env block" warning in other specs does not apply here.

### 2. `container/agent-runner/src/providers/claude.ts` — before `query()`

Write project-scope settings so spawned teammates inherit MCP servers. Insert before the `const q = query(...)` call:

```ts
// Write .claude/settings.json so spawned teammates inherit MCP server config.
// Teammates load project-scope settings from cwd automatically; they cannot
// access the parent's sdkOptions.mcpServers at runtime.
// Overwrite is intentional — MCP config is derived from env vars which don't
// change between query() calls in the same container lifecycle.
const settingsDir = path.join(options.cwd, '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({
  mcpServers: options.mcpServers ?? {},
  teammateMode: 'in-process',
}, null, 2), 'utf8');
```

> `teammateMode: "in-process"` is written here (not as an env var) — the correct way to configure this is via `settings.json` or `--teammate-mode` CLI flag. The default "auto" mode already falls back to in-process when tmux is unavailable, but explicit configuration is safer in containers.

> The `env:` key is NOT written to settings.json — Claude Code does not honour an `env` field in project settings.json. The agent teams feature is activated by the process env var injected by agent-manager (Step 1 above).

> `options.cwd` is `/workspace` for both ephemeral (line 235) and persistent (line 570) agents — confirmed. The settings file lands at `/workspace/.claude/settings.json` in all cases.

> The `/workspace/.claude/` directory is created at runtime by `mkdirSync({ recursive: true })`. No Dockerfile change needed.

### 3. `container/agent-runner/src/providers/claude.ts` — `defaultTools`

Add agent team tools to `defaultTools` (line 23 in `claude.ts`, not in `index.ts`):

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

This single change covers both the NATS loop path and the ephemeral path since both call `provider.run()` which delegates to `claude.ts`.

---

## CLAUDE.md Considerations

Teammates load the agent's `CLAUDE.md` from `/workspace/CLAUDE.md` automatically (same `cwd`). The agent's identity (e.g. "you are sd-developer") is visible to all teammates.

The lead must override this in spawn prompts with task-specific roles:

```
Spawn a teammate with prompt: "You are a test writer. Your only job is to write
unit tests for src/auth/login.ts. Do not modify any other files."
```

No changes to existing `CLAUDE.md` files are required. The spawn prompt takes precedence over the shared identity for the teammate's specific task.

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
- **Not persistent team state** — team dirs in `~/.claude/teams/` are transient; ephemeral containers clean up on exit, persistent containers lose state on restart (acceptable)

---

## Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` feature | Available — container pins `@anthropic-ai/claude-code@2.1.76` (minimum is 2.1.32) | No version change needed |
| `buildAgentEnvAndBinds()` in `agent-manager.ts` | Existing single function (signature line 933, env array line 1012) | Called by all three agent start paths |
| `/workspace` bind mount | Existing | `.claude/settings.json` written here at runtime |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| LLM over-uses teams on simple tickets | Sonnet+ models are self-regulating; haiku agents unlikely to use teams at all |
| Teammates write to same files | Lead's spawn prompts must include explicit file ownership per task |
| settings.json overwrite between query() calls | Overwrite is safe — MCP config is derived from env vars that don't change mid-lifecycle |
| Proxy mode settings.json conflict | No conflict: proxy mounts user-scope (`~/.claude/settings.json`), we write project-scope (`/workspace/.claude/settings.json`); Claude Code merges both |
| Team state lost on persistent agent restart | Acceptable — teams are transient working memory, not source of truth; ticket system is authoritative |
