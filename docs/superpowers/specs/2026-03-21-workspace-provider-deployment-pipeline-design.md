# Workspace Provider & Deployment Pipeline — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Scope:** Isolated git worktrees for self-dev pipeline, immediate deploy strategy, full deploy cycle
**Supersedes:** `2026-03-20-workspace-provider-and-deployment-pipeline-design.md` (batch strategy removed, simplified)

---

## Overview

The self-dev pipeline agents currently have direct read-write access to the live nano-agent-team source code via `project_workspace: true`. This means a broken change can take down the running system, there's no isolation between concurrent tickets, and no deploy gate before changes go live.

This spec introduces:

1. **Workspace Provider** — manages git worktrees as on-demand isolated workspaces
2. **Agent Manager changes** — dynamic workspace mounting per ticket
3. **sd-release-manager** — merges feature branches into main, escalates conflicts
4. **sd-ops** — builds, deploys, health checks (no merge responsibility)
5. **sd-hub-publisher** — publishes hub artifacts as PRs to the hub repo

Deploy strategy is **immediate** — each ticket deploys independently after commit. No batch releases, no release branches.

---

## Architecture

```
PM creates ticket + workspace_create (worktree from bare repo)
  → Architect writes spec in isolated worktree
    → Developer implements in isolated worktree
      → Reviewer reviews in isolated worktree
        → Committer commits + pushes feature branch
          → Release Manager merges feat branch into main
            → OK → sd-ops builds + deploys + health check
            → Conflict → leaves unresolved merge in worktree → back to Developer
              → Developer resolves conflict markers → review → commit → release manager again
          → sd-hub-publisher (if hub artifact) → PR on hub repo
```

### Key decisions

- **Bare repos cloned from GitHub** (GH_TOKEN required) — full isolation from live repo
- **Immediate deploy** — one ticket at a time, no release branches
- **Graceful drain for core restart** — `/internal/restart` endpoint, Docker restart policy recovers; control plane performs post-restart health check and publishes deploy result
- **Single GH_TOKEN** for both repos (env injection now, secret manager later) — required by sd-release-manager (push to main) and sd-hub-publisher (PR on hub repo)
- **Merge conflicts resolved by developer** — release manager leaves unresolved merge in worktree with conflict markers, developer sees exactly what to fix
- **No proactive rebase** — worktrees are never modified by workspace provider after creation
- **Workflow bindings are authoritative** — agent input routing is controlled by `workflow.json` bindings, not manifest fields. Manifest `entrypoints: ["inbox", "task"]` declares capability; bindings wire NATS topics to those entrypoints
- **Single consumer serialization** — sd-release-manager has one JetStream consumer, so merge-to-main operations are naturally serialized. Concurrent merge conflicts cannot occur.

---

## 1. Workspace Provider (`src/workspace-provider.ts`)

Internal service managing git worktrees as on-demand resources.

### Storage layout

```
data/workspaces/
  repos/                              # bare repos
    nano-agent-team.git/
    hub.git/
  active/                             # checked-out worktrees
    ws-{nanoid}/
  index.json                          # workspaceId → metadata
```

### Bare repo management

On startup (or first request), the provider clones bare repos:

```bash
git clone --bare https://github.com/owner/nano-agent-team.git data/workspaces/repos/nano-agent-team.git
git clone --bare https://github.com/owner/hub.git data/workspaces/repos/hub.git
```

Periodic `git fetch --all` every 5 minutes to stay current with remote.

Repo URLs configured in `config.json`:

```json
{
  "workspaceRepos": {
    "nano-agent-team": "https://github.com/owner/nano-agent-team.git",
    "hub": "https://github.com/owner/hub.git"
  }
}
```

### Worktree lifecycle

**Create** — called by PM after ticket approval (synchronous, blocks until ready):

```bash
# If bare repo doesn't exist yet, clone it first (slow, one-time)
git clone --bare <url> data/workspaces/repos/<repoType>.git

# Create worktree with feature branch from latest main
git -C repos/<repoType>.git worktree add \
  ../active/ws-{nanoid} -b feat/TICK-001 main
```

Worktree creation is near-instant (no network after initial clone).

**Return** — called by release manager after successful deploy:

```bash
git -C repos/<repoType>.git worktree remove ../active/ws-{nanoid}

# Only delete branch after confirmed merge to main AND push to remote
git -C repos/<repoType>.git branch --merged main | grep feat/TICK-001 && \
  git -C repos/<repoType>.git branch -D feat/TICK-001
```

Branch deletion is conditional: only if the branch is verified as merged into main. If deploy failed or workspace is returned early, the branch is preserved (remote still has it as backup).

### Index

`index.json` maps workspaceId to metadata:

```json
{
  "ws-a1b2c3d4": {
    "workspaceId": "ws-a1b2c3d4",
    "path": "/data/workspaces/active/ws-a1b2c3d4",
    "repoType": "nano-agent-team",
    "branch": "feat/TICK-001",
    "ownerId": "TICK-001",
    "status": "checked-out",
    "createdAt": "2026-03-21T10:00:00Z"
  }
}
```

### API — Internal REST endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/workspaces` | Create workspace `{ repoType, branch?, ownerId? }` → `{ workspaceId, path }` |
| GET | `/internal/workspaces/:id` | Get workspace metadata + path |
| GET | `/internal/workspaces/by-owner/:ownerId` | Find workspace by owner |
| DELETE | `/internal/workspaces/:id` | Return workspace (remove worktree, optionally delete branch) |
| GET | `/internal/workspaces` | List all workspaces |

### MCP tools (for PM and Foreman)

| Tool | Description |
|------|-------------|
| `workspace_create(repoType, ownerId?, branch?)` | Create worktree workspace, returns workspaceId + path. Branch defaults to `main`. |
| `workspace_get(workspaceId)` | Get workspace path + metadata |
| `workspace_find(ownerId)` | Find workspace by owner ID |
| `workspace_return(workspaceId)` | Return workspace (remove worktree) |
| `workspace_list()` | List all active workspaces |

---

## 2. Agent Manager Changes

### New manifest field

```json
{
  "workspace_source": "ticket"
}
```

Replaces `project_workspace: true` for all self-dev agents.

### Flow on container start

1. Agent-manager reads `ticket_id` and `workspaceId` from NATS message payload
2. Calls `GET /internal/workspaces/by-owner/{ticket_id}` (or uses workspaceId directly)
3. Gets worktree path (e.g., `/data/workspaces/active/ws-a1b2c3d4`)
4. Mounts as `/workspace/repo:rw` in container (via `HOST_DATA_DIR` prefix for Docker socket)

### Fallback

- Workspace not found for ownerId → agent refuses task, adds comment on ticket ("workspace not found, likely PM did not create it"), nack NATS message
- This is a safety net for PM bugs — should not happen in normal flow because PM creates workspace synchronously before publishing downstream

### Migration

Self-dev agents change from `project_workspace: true` to `workspace_source: "ticket"`:

- `sd-developer` — RW access to worktree
- `sd-reviewer` — RW access (needs to run tests)
- `sd-committer` — RW access (commits + pushes)
- `sd-architect` — RW access (reads source, writes spec as ticket comment)
- `sd-release-manager` — RW access (merge operations, git push)
- `sd-pm` — no workspace needed (ticket MCP tools only, calls `workspace_create`)
- `sd-ops` — no workspace needed (uses MCP tools: `deploy_feature`, `restart_self`, `health_check`)
- `sd-hub-publisher` — creates own hub workspace via `workspace_create` (see Section 5)
- `foreman` — no workspace needed (routing + notifications)

### NATS payload change

All downstream NATS messages include `workspaceId`:

```json
{
  "ticket_id": "TICK-001",
  "workspaceId": "ws-a1b2c3d4"
}
```

PM sets this when approving the ticket. Every agent passes it through to the next stage.

---

## 3. sd-release-manager

**Role:** Merges feature branches into main. Escalates conflicts to developer.

### Manifest (partial — `workspace_source: "ticket"` added during migration, see Section 2)

```json
{
  "id": "sd-release-manager",
  "name": "Release Manager",
  "provider": "claude",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.release.ready", "topic.merge.conflict"],
  "mcp_permissions": {
    "management": ["workspace_get", "workspace_return"],
    "tickets": ["get", "comment"]
  }
}
```

### Trigger

`topic.commit.done` — from sd-committer after successful commit + push.

### Workflow

1. Open ticket's worktree (from workspaceId in NATS payload)
2. `git fetch origin main`
3. `git merge origin/main` (merge main INTO feature branch)
4. **Clean merge:**
   - `git push origin feat/TICK-XXX`
   - Fast-forward merge into main: `git push origin feat/TICK-XXX:main`
   - Publish `topic.release.ready { ticket_id, workspaceId }`
5. **Merge conflict:**
   - Leave unresolved merge in worktree (conflict markers in files)
   - Add ticket comment: "Merge conflict with current main on files: X, Y. Conflict markers left in worktree for resolution."
   - Publish `topic.merge.conflict { ticket_id, workspaceId, conflicting_files[] }`

### After successful deploy

- Receives `topic.deploy.done`
- Calls `workspace_return(workspaceId)` to cleanup worktree

---

## 4. sd-ops (Operations Agent)

**Role:** Stateless executor — build, deploy, health check. No merge responsibility.

### Manifest

```json
{
  "id": "sd-ops",
  "name": "Operations Agent",
  "provider": "claude",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.deploy.done", "topic.deploy.failed", "topic.hub.deploy"],
  "mcp_permissions": {
    "management": ["deploy_feature", "restart_self", "health_check"]
  }
}
```

### Trigger

`topic.release.ready` — from release manager after successful merge into main.

### Workflow

1. Checkout main (already updated by release manager)
2. Detect artifact type from changed files:
   - `src/` or `dashboard/` → **core change**
   - `features/` → **feature plugin**
   - files under hub agent/team paths → **hub artifact**
3. **Feature:** Call `deploy_feature(feature_name)` → hot-reload, no restart → sd-ops publishes `topic.deploy.done`
4. **Core:** Call `restart_self({ ticket_id, workspaceId })` → control plane takes over (see below). sd-ops is killed as part of the drain — the control plane handles the rest.
5. **Hub artifact:** Publish `topic.hub.deploy { ticket_id, workspaceId }` → sd-hub-publisher handles it
6. **Mixed artifacts:** Execute in order: hub → feature → core (core last, because restart kills agents)

### Core deploy: restart_self flow

sd-ops cannot survive the restart it initiates — all agent containers are stopped during graceful drain. The control plane itself handles the post-restart verification:

**`restart_self(deployContext)`** — `POST /internal/restart`

The MCP tool accepts deploy context (ticket_id, workspaceId) which is persisted to `data/pending-deploy.json` before restart.

**Pre-restart (control plane, synchronous):**
1. Write `data/pending-deploy.json` with `{ ticket_id, workspaceId, previousMainCommit }`
2. `docker build` new image from updated main
3. If build fails → publish `topic.deploy.failed`, delete pending-deploy.json, done (no restart)
4. Drain NATS JetStream consumers (ack pending messages)
5. Stop all running agent containers gracefully (SIGTERM + 10s timeout)
6. Close HTTP server
7. `process.exit(0)` — Docker restart policy restarts the container with new image

**Post-restart (control plane startup):**
1. On startup, check for `data/pending-deploy.json`
2. If exists: run self-test (`/api/health` internal check, NATS connectivity, agent-manager ready)
3. **Health OK:** publish `topic.deploy.done { ticket_id, workspaceId, artifact_type: "core" }`, delete pending-deploy.json
4. **Health FAIL:** rollback — `git revert HEAD` on main (creates revert commit, safe even if other commits followed), rebuild old image, restart again. Only one rollback attempt is made — if the reverted version also fails health check, the system publishes `topic.deploy.failed { ticket_id, workspaceId, error: "rollback also failed" }`, deletes pending-deploy.json, and stays running on whatever state it has. No revert loop.

`git revert HEAD` is chosen over `git reset --hard` because it is safe: it creates a new commit that undoes the change, preserving history and not destroying any concurrent work.

**`health_check`** — `GET /api/health` wrapper

Returns health status with timeout. Used internally by post-restart self-test.

---

## 5. sd-hub-publisher

**Role:** Publishes hub artifacts (agent manifests, CLAUDE.md, Dockerfiles) as PRs to the hub repo.

### Manifest

```json
{
  "id": "sd-hub-publisher",
  "name": "Hub Publisher",
  "provider": "claude",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.hub.published"],
  "mcp_permissions": {
    "management": ["workspace_create", "workspace_return"],
    "tickets": ["get", "comment"]
  }
}
```

### Trigger

`topic.hub.deploy` — from sd-ops when hub artifact detected.

Payload: `{ ticket_id, workspaceId }` — workspaceId refers to the nano-agent-team worktree where hub artifacts were developed.

### Workflow

1. Read ticket for context
2. Call `workspace_create("hub", ticket_id)` — creates a hub worktree for publishing
3. Copy hub artifacts from ticket worktree (nano-agent-team) into hub worktree
4. `git checkout -b feat/TICK-XXX` + commit + push
5. `gh pr create --title "..." --body "..."`
6. Call `workspace_return(hubWorkspaceId)` — cleanup hub worktree
7. Add ticket comment with PR URL
8. Publish `topic.hub.published { ticket_id, pr_url }`

### Requirements

- GH_TOKEN with push access to hub repo (env injection, secret manager later)
- `gh` CLI available in container (already in nano-agent base image)

---

## 6. NATS Topic Map

### Updated workflow

```
topic.ticket.new → PM
  PM calls workspace_create(), gets workspaceId
  → topic.ticket.approved { ticket_id, workspaceId } → Architect
    → topic.ticket.spec-ready { ticket_id, workspaceId } → Developer
      → topic.dev.done { ticket_id, workspaceId } → Reviewer
        → topic.review.passed { ticket_id, workspaceId } → Committer
          → topic.commit.done { ticket_id, workspaceId } → Release Manager
            → topic.release.ready { ticket_id, workspaceId } → sd-ops
              → topic.deploy.done { ticket_id, workspaceId } → Release Manager (cleanup)
              → topic.deploy.failed { ticket_id, workspaceId, error } → Foreman (notification)
              → topic.hub.deploy { ticket_id, workspaceId } → sd-hub-publisher
                → topic.hub.published { ticket_id, pr_url } → Foreman (notification)
            → topic.merge.conflict { ticket_id, workspaceId, conflicting_files } → Developer
              → topic.dev.done → ... (back through review pipeline)
        → topic.dev.retry { ticket_id, workspaceId } → Developer (review failed)
```

### New topics

| Topic | Publisher | Consumer | Payload |
|-------|-----------|----------|---------|
| `topic.release.ready` | sd-release-manager | sd-ops | `{ ticket_id, workspaceId }` |
| `topic.merge.conflict` | sd-release-manager | Developer | `{ ticket_id, workspaceId, conflicting_files[] }` |
| `topic.deploy.done` | sd-ops | sd-release-manager | `{ ticket_id, workspaceId, artifact_type }` |
| `topic.deploy.failed` | sd-ops | Foreman | `{ ticket_id, workspaceId, error }` |
| `topic.hub.deploy` | sd-ops | sd-hub-publisher | `{ ticket_id, workspaceId }` |
| `topic.hub.published` | sd-hub-publisher | Foreman | `{ ticket_id, pr_url }` |

---

## 7. Workflow.json Changes

New agents added to self-dev-team:

```json
{
  "id": "self-dev-team",
  "agents": ["sd-pm", "sd-architect", "sd-developer", "sd-reviewer", "sd-committer", "sd-release-manager", "sd-ops", "sd-hub-publisher"],
  "bindings": {
    "sd-release-manager": {
      "inputs": {
        "commit_done": { "from": "topic.commit.done", "to": "task" },
        "deploy_done": { "from": "topic.deploy.done", "to": "task" }
      },
      "outputs": {
        "release_ready": "topic.release.ready",
        "merge_conflict": "topic.merge.conflict"
      }
    },
    "sd-ops": {
      "inputs": {
        "release_ready": { "from": "topic.release.ready", "to": "task" }
      },
      "outputs": {
        "deploy_done": "topic.deploy.done",
        "deploy_failed": "topic.deploy.failed",
        "hub_deploy": "topic.hub.deploy"
      }
    },
    "sd-hub-publisher": {
      "inputs": {
        "hub_deploy": { "from": "topic.hub.deploy", "to": "task" }
      },
      "outputs": {
        "hub_published": "topic.hub.published"
      }
    }
  }
}
```

Developer gets additional input for merge conflicts:

```json
"sd-developer": {
  "inputs": {
    "spec_ready": { "from": "topic.ticket.spec-ready", "to": "task" },
    "dev_retry": { "from": "topic.dev.retry", "to": "task" },
    "merge_conflict": { "from": "topic.merge.conflict", "to": "task" }
  }
}
```

Foreman gets deploy notifications:

```json
"foreman": {
  "inputs": {
    "deploy_failed": { "from": "topic.deploy.failed", "to": "task" },
    "hub_published": { "from": "topic.hub.published", "to": "task" }
  }
}
```

Note: `topic.deploy.done` goes to sd-release-manager (cleanup), not Foreman. Foreman only receives failure/hub notifications.

---

## 8. Config Changes

New `config.json` fields:

```json
{
  "workspaceRepos": {
    "nano-agent-team": "https://github.com/owner/nano-agent-team.git",
    "hub": "https://github.com/owner/hub.git"
  }
}
```

---

## 9. Pipeline Flow Example

### Normal flow (no conflict)

```
1. User tells Foreman: "Add health endpoint timeout config"
2. Foreman creates ticket TICK-010
3. PM approves, calls workspace_create("nano-agent-team", "TICK-010")
   → worktree: /data/workspaces/active/ws-x1/ (branch feat/TICK-010 from main)
4. PM publishes topic.ticket.approved { ticket_id: "TICK-010", workspaceId: "ws-x1" }
5. Architect reads source in ws-x1, writes spec as ticket comment
6. Developer implements in ws-x1
7. Reviewer reviews in ws-x1, approves
8. Committer: git add + commit + push feat/TICK-010
9. Release Manager: git fetch main, git merge main → clean
   → push feat/TICK-010:main → topic.release.ready
10. sd-ops: detects src/ change → docker build → restart_self → health_check ✅
    → topic.deploy.done
11. Release Manager: workspace_return("ws-x1") → cleanup
```

### Conflict flow

```
1. TICK-010 is at developer, worktree ws-x1 from main@abc123
2. TICK-011 completes and deploys, main advances to main@def456
3. TICK-010 completes, committer pushes feat/TICK-010
4. Release Manager: git merge main → CONFLICT on src/api-server.ts
   → leaves conflict markers in ws-x1
   → ticket comment: "Merge conflict with main on src/api-server.ts"
   → topic.merge.conflict { ticket_id: "TICK-010", workspaceId: "ws-x1", conflicting_files: ["src/api-server.ts"] }
5. Developer opens ws-x1, sees <<<< HEAD / >>>> markers
   → resolves conflict → git add + git commit (merge commit)
   → topic.dev.done
6. Reviewer reviews resolved merge
7. Committer pushes the merge commit (no additional commit needed — developer already committed the merge resolution)
8. Release Manager: verifies main is clean → topic.release.ready → deploy
```

---

## 10. New Core MCP Tools

Added to management MCP server:

| Tool | Endpoint | Description |
|------|----------|-------------|
| `workspace_create` | `POST /internal/workspaces` | Create worktree workspace |
| `workspace_get` | `GET /internal/workspaces/:id` | Get workspace metadata |
| `workspace_find` | `GET /internal/workspaces/by-owner/:ownerId` | Find by owner |
| `workspace_return` | `DELETE /internal/workspaces/:id` | Cleanup worktree |
| `workspace_list` | `GET /internal/workspaces` | List active workspaces |
| `restart_self` | `POST /internal/restart` | Graceful drain + exit (Docker restarts) |
| `health_check` | `GET /api/health` | Health check with timeout |

---

## 11. Migration Path

All changes deploy together as one feature:

1. Workspace Provider service + REST endpoints + MCP tools
2. Agent Manager `workspace_source: "ticket"` support
3. New agents: sd-release-manager, sd-ops, sd-hub-publisher (hub catalog + CLAUDE.md)
4. Updated workflow.json with new bindings
5. PM CLAUDE.md updated: call `workspace_create` on ticket approval
6. Developer CLAUDE.md updated: handle `topic.merge.conflict` (resolve conflict markers)
7. Committer CLAUDE.md updated: handle "push-only" case after merge conflict resolution (developer already committed merge, committer only needs to push)
8. Remove `project_workspace: true` from all self-dev agent manifests
8. Foreman Workflow E updated: routing to release manager instead of direct deploy

---

## Out of Scope

- Batch release strategy (release branches) — future enhancement if needed
- Workspace quotas or disk management
- CI/CD integration (GitHub Actions)
- Multi-environment deployment (staging/production)
- Secret manager integration for GH_TOKEN
- Automated testing beyond health check in deploy pipeline
