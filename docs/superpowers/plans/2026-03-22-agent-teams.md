# Agent Teams Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable all nano-agent-team agents to use `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` so the LLM can autonomously spawn teammate sub-instances for complex tickets.

**Architecture:** Three focused changes: (1) add one env var to `buildAgentEnvAndBinds()` in agent-manager, (2) add `AGENT_TEAM_TOOLS` to `defaultTools` in `claude.ts`, (3) write `/workspace/.claude/settings.json` before `query()` so teammates inherit MCP servers and `teammateMode: "in-process"`.

**Tech Stack:** TypeScript, Docker, Claude Code SDK (`@anthropic-ai/claude-agent-sdk`), vitest (control plane tests only)

---

## File Map

| File | Change | Why |
|------|--------|-----|
| `src/agent-manager.ts` | Add 1 env var to `buildAgentEnvAndBinds()` env array (line ~1029) | Activate feature for all agent containers |
| `container/agent-runner/src/providers/claude.ts` | Add `AGENT_TEAM_TOOLS` to `defaultTools`; write settings.json before `query()` | Allow team tools + MCP inheritance for teammates |

No new files. No Dockerfile changes. No schema changes.

---

## Task 1: Add `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to agent-manager

**Files:**
- Modify: `src/agent-manager.ts:1029` (inside `buildAgentEnvAndBinds()` env array)

- [ ] **Step 1: Locate the insertion point**

Open `src/agent-manager.ts`. Find `buildAgentEnvAndBinds` (line 933). Scroll to the env array (starts at line 1012). Find lines 1029–1035 — the new line goes between `PRELOAD_SKILLS` (line 1031) and `REPO_URL` (line 1033), **before** the large `!isDeterministic` block that starts at line 1037:

```ts
// Enable context-mode MCP server for code search (opt-in via manifest) — LLM agents only
...(!isDeterministic && agent.manifest.context_mode ? ['CONTEXT_MODE=true'] : []),
// Preload specific skills into systemPrompt (injected at startup) — LLM agents only
...(!isDeterministic && agent.manifest.preload_skills?.length ? [`PRELOAD_SKILLS=${agent.manifest.preload_skills.join(',')}`] : []),
// Pass repo URL from config (set during team install)
...(repoUrl ? [`REPO_URL=${repoUrl}`] : []),
// Deterministic agent: inject handler module name, skip all LLM-specific vars
...(isDeterministic && agent.manifest.handler ? [`HANDLER=${agent.manifest.handler}`] : []),
// LLM-specific env vars (skipped for deterministic agents)
...(!isDeterministic ? [
```

- [ ] **Step 2: Insert the unconditional env var between `PRELOAD_SKILLS` and `REPO_URL`**

The new line is unconditional (no `!isDeterministic` guard) — it must sit **outside** the `!isDeterministic` spread block at line 1037. Insert it at line 1032:

```ts
// Preload specific skills into systemPrompt (injected at startup) — LLM agents only
...(!isDeterministic && agent.manifest.preload_skills?.length ? [`PRELOAD_SKILLS=${agent.manifest.preload_skills.join(',')}`] : []),
// Agent teams: enable native Claude Code multi-agent coordination (unconditional)
'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
// Pass repo URL from config (set during team install)
...(repoUrl ? [`REPO_URL=${repoUrl}`] : []),
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent-manager.ts
git commit -m "feat: enable CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS for all LLM agents"
```

---

## Task 2: Add `AGENT_TEAM_TOOLS` to `defaultTools` in `claude.ts`

**Files:**
- Modify: `container/agent-runner/src/providers/claude.ts:23`

- [ ] **Step 1: Locate `defaultTools` in `claude.ts`**

Open `container/agent-runner/src/providers/claude.ts`. Find line 23:

```ts
const defaultTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', ...mcpToolPatterns];
```

- [ ] **Step 2: Replace line 23 with the `AGENT_TEAM_TOOLS` constant + updated `defaultTools`**

**Replace** the existing `const defaultTools = [...]` line (line 23) with:

```ts
// Native Claude Code agent team tools (available when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)
const AGENT_TEAM_TOOLS = [
  'TeamCreate', 'TaskCreate', 'TaskUpdate', 'TaskList',
  'Task', 'SendMessage', 'TeamDelete',
];

const defaultTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', ...mcpToolPatterns, ...AGENT_TEAM_TOOLS];
```

Do **not** leave the original `const defaultTools` line in place — that would create a duplicate `const` declaration and fail TypeScript compilation.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team/container/agent-runner
npm run build
```

Expected: no TypeScript errors in `dist/`.

- [ ] **Step 4: Commit**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
git add container/agent-runner/src/providers/claude.ts
git commit -m "feat: add agent team tools to defaultTools in ClaudeProvider"
```

---

## Task 3: Write settings.json before `query()` for teammate MCP inheritance

**Files:**
- Modify: `container/agent-runner/src/providers/claude.ts` (before `const q = query(...)` call, line ~59)

- [ ] **Step 1: Locate the `query()` call in `claude.ts`**

In `container/agent-runner/src/providers/claude.ts`, find this line (around line 59):

```ts
const q = query({ prompt: options.prompt, options: sdkOptions });
```

- [ ] **Step 2: Insert settings.json write immediately before `const q = query(...)`**

```ts
// Write project-scope .claude/settings.json so spawned teammates inherit MCP server config
// and run in in-process mode (no tmux needed in containers).
// Teammates load project-scope settings from cwd; they cannot access parent's sdkOptions at runtime.
// Overwrite is safe — MCP config derives from env vars that are constant per container lifecycle.
const settingsDir = path.join(options.cwd, '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({
  mcpServers: options.mcpServers ?? {},
  teammateMode: 'in-process',
}, null, 2), 'utf8');

const q = query({ prompt: options.prompt, options: sdkOptions });
```

- [ ] **Step 3: Verify `path` and `fs` are already imported**

Check the top of `claude.ts` — both `import fs from 'fs'` and `import path from 'path'` should already be present (they are, lines 7–8). No new imports needed.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team/container/agent-runner
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
git add container/agent-runner/src/providers/claude.ts
git commit -m "feat: write .claude/settings.json before query() for teammate MCP inheritance"
```

---

## Task 4: Rebuild images and smoke test

**Files:** None (Docker image rebuild only)

- [ ] **Step 1: Rebuild agent-runner image**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
```

Use `/nat-agent-rebuild` skill or manually:

```bash
docker build -t nano-agent:latest ./container/agent-runner/
```

- [ ] **Step 2: Rebuild full stack (control plane only)**

> Note: `docker compose up --build` rebuilds the control plane (`nano-agent-team`) image but does **NOT** rebuild `nano-agent:latest`. Step 1 must complete before this step to ensure agent containers pick up the changes from Tasks 2 and 3.

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
docker compose down && docker compose up --build -d
```

- [ ] **Step 3: Verify env var is set in a running agent container**

Wait for a persistent agent to start (e.g. sd-pm), then:

```bash
docker exec nano-agent-sd-pm env | grep CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
```

Expected output:
```
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

- [ ] **Step 4: Verify settings.json write in ephemeral agent**

Send a test ticket through the pipeline and check the resulting workspace:

```bash
ls /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team/data/workspaces/active/
# pick a ws-* dir
cat data/workspaces/active/ws-<id>/.claude/settings.json
```

Expected: JSON with `mcpServers` and `teammateMode: "in-process"`.

---

## Task 5: Create GitHub issue

- [ ] **Step 1: Write issue body to `/tmp/agent-teams-issue.md`**

```bash
cat > /tmp/agent-teams-issue.md << 'EOF'
## Summary

Enable all nano-agent-team LLM agents to use Claude Code's native agent teams feature.
Each agent can now autonomously spawn teammate sub-instances for complex tickets.

## Changes

- `src/agent-manager.ts` — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` added to all agent envs
- `container/agent-runner/src/providers/claude.ts` — `AGENT_TEAM_TOOLS` in `defaultTools`; settings.json write for teammate MCP inheritance

## Design

Spec: `docs/superpowers/specs/2026-03-22-agent-teams-design.md`

## Testing

- Verify env var present in running agent containers
- Verify `.claude/settings.json` written in workspace dir on first query()
EOF
```

- [ ] **Step 2: Create GH issue in core repo**

```bash
gh issue create \
  --repo nano-agent-team/nano-agent-team \
  --title "feat: enable CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS for all LLM agents" \
  --label "enhancement" \
  --body-file /tmp/agent-teams-issue.md
```
