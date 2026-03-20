# Workspace Provider & Deployment Pipeline

## Problem

The self-dev pipeline agents (sd-developer, sd-committer) currently have direct read-write access to the live nano-agent-team source code via `project_workspace: true`. This means:

- A broken change can take down the running system with no rollback
- No isolation between concurrent ticket work
- No review/merge/deploy gate before changes go live
- No batch release capability

## Goal

Isolate agent development work into git worktrees, add a proper merge + build + deploy + rollback pipeline, and support both immediate and batch release strategies.

## Scope

This spec covers three tightly coupled subsystems:

1. **Workspace Provider** — manages git worktrees as on-demand resources
2. **Deployment Pipeline** — new agents (sd-ops, sd-release-manager, sd-hub-publisher) and Foreman workflow changes
3. **Agent Manager changes** — dynamic workspace mounting per ticket

## Architecture Overview

```
PM creates ticket + provisions workspace (worktree)
  → Architect writes spec
    → Developer implements in isolated worktree (feature branch)
      → Reviewer reviews
        → Committer commits to feature branch
          → Foreman routes:
              → Release Manager merges into release/main branch
                → Ops Agent builds + deploys + health checks
              → Hub Publisher pushes to hub repo as PR
              → Or just notifies user (docs/config changes)
```

### Artifact types

The pipeline can produce three types of artifacts:

| Type | Example | Build step | Deploy step |
|------|---------|-----------|-------------|
| **Feature** | `features/hello-world/plugin.mjs` | `npm run build` if package.json, else no-op | Copy to `/data/features/` + reload |
| **Hub artifact** | Agent manifest + CLAUDE.md | No-op | Git push + PR on hub repo |
| **Core change** | `src/*.ts`, `dashboard/` | `docker build` | Container swap + health check, rollback on failure |

---

## 1. Workspace Provider

### Overview

Internal service (`src/workspace-provider.ts`) that manages git worktrees as on-demand resources. Exposed via REST endpoints (`/internal/workspaces/*`) and MCP tools.

### Storage layout

```
DATA_DIR/workspaces/
  repos/                              # bare repos (one per source)
    nano-agent-team.git/
    hub.git/
  active/                             # checked-out worktrees
    {workspaceId}/                    # e.g., ws-a1b2c3d4/
  index.json                          # workspaceId -> metadata
  owners.json                         # ownerId -> workspaceId
```

### Bare repo management

On startup (or first request), the provider clones bare repos:

```bash
git clone --bare <url> DATA_DIR/workspaces/repos/nano-agent-team.git
git clone --bare <url> DATA_DIR/workspaces/repos/hub.git
```

Bare repos are updated periodically (`git fetch --all`) to stay current with remote.

### Worktree lifecycle

**Create:**
```bash
# Provider generates workspaceId (e.g., ws-a1b2c3d4)
# Creates feature branch from latest main
git -C repos/nano-agent-team.git worktree add \
  ../active/ws-a1b2c3d4 -b feat/TICK-001 main
```

**Return:**
```bash
git -C repos/nano-agent-team.git worktree remove ../active/ws-a1b2c3d4
git -C repos/nano-agent-team.git branch -D feat/TICK-001  # if merged
```

Worktree creation is near-instant (no network, no clone). This replaces the pool concept — worktrees are cheap enough that pooling is unnecessary.

### Index

`index.json` maps workspaceId to metadata:
```json
{
  "ws-a1b2c3d4": {
    "path": "/data/workspaces/active/ws-a1b2c3d4",
    "repoType": "nano-agent-team",
    "branch": "feat/TICK-001",
    "status": "checked-out",
    "createdAt": "2026-03-20T10:00:00Z"
  }
}
```

`owners.json` maps any owner ID to workspaceId:
```json
{
  "TICK-001": "ws-a1b2c3d4",
  "GH-42": "ws-b2c3d4e5"
}
```

Owner IDs are opaque strings — can be ticket IDs, GH issue numbers, or anything else.

### API

**Internal REST endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/workspaces` | Create workspace `{ repoType, branch?, ownerId? }` → `{ workspaceId, path }` |
| GET | `/internal/workspaces/:id` | Get workspace metadata + path |
| GET | `/internal/workspaces/by-owner/:ownerId` | Find workspace by owner |
| DELETE | `/internal/workspaces/:id` | Return workspace (remove worktree, optionally delete branch) |
| GET | `/internal/workspaces` | List all workspaces (debug/monitoring) |

**MCP tools (for PM and other agents):**

| Tool | Description |
|------|-------------|
| `workspace_create(repoType, ownerId?)` | Create new workspace, returns workspaceId + path |
| `workspace_get(workspaceId)` | Get workspace path |
| `workspace_find(ownerId)` | Find workspace by owner ID |
| `workspace_return(workspaceId)` | Return workspace to provider |
| `workspace_list()` | List all active workspaces |

### New repo types

When the provider receives a `repoType` it hasn't seen before, it clones the bare repo on demand (slow, first time only). Known repo types and their URLs are configured in `config.json`:

```json
{
  "workspaceRepos": {
    "nano-agent-team": "https://github.com/nano-agent-team/nano-agent-team.git",
    "hub": "https://github.com/nano-agent-team/hub.git"
  }
}
```

New entries can be added via config without code changes.

---

## 2. Agent Manager Changes

### New manifest field

```typescript
interface AgentManifest {
  // existing fields...

  /** Read workspace path from ticket metadata, mount as /workspace/repo */
  workspace_source?: "ticket";
}
```

When `workspace_source: "ticket"`:
1. Agent-manager reads `ticket_id` from NATS message payload
2. Calls `GET /internal/workspaces/by-owner/{ticket_id}`
3. Mounts returned path as `/workspace/repo:rw` in container

### Migration

Self-dev agents change from:
```json
{ "project_workspace": true }
```
to:
```json
{ "workspace_source": "ticket" }
```

`project_workspace: true` is removed from all self-dev agent manifests. No agent gets direct access to live source code.

### Fallback behavior

If workspace is not yet ready (provider still cloning bare repo for first time):
- Agent-manager retries for up to 30 seconds
- If still not ready, nack the NATS message (returns to queue for redelivery)
- Log warning for observability

---

## 3. New Agents

### sd-ops (Operations Agent)

**Role:** Stateless executor — builds, deploys, health checks, rolls back.

**Manifest:**
```json
{
  "id": "sd-ops",
  "name": "Operations Agent",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.deploy.done", "topic.deploy.failed"],
  "mcp_permissions": {
    "management": ["deploy_feature", "restart_self", "health_check"]
  }
}
```

**Listens on:** `agent.sd-ops.task`

**Payload:**
```json
{
  "action": "deploy",
  "workspaceIds": ["ws-a1b2c3d4", "ws-b2c3d4e5"],
  "ticket_id": "TICK-001"
}
```

**Behavior:**
1. For each workspaceId, inspect workspace to determine artifact type
2. Build (if needed): `npm run build` for features, `docker build` for core
3. Deploy based on type: hotplug (feature), container swap (core)
4. Health check: `GET /api/health`
5. Success → publish `topic.deploy.done`
6. Failure → rollback + publish `topic.deploy.failed`

**Stateless:** Ops agent holds no state. It receives a list of workspaces, deploys them, reports results. All deployment strategy logic lives in Foreman or Release Manager.

**Core MCP tools needed:**
- `deploy_feature(feature_name)` — already exists
- `restart_self()` — new, restarts nano-agent-team container
- `health_check()` — new, `GET /api/health` with timeout

### sd-release-manager (Release Manager)

**Role:** Manages release branches and merge strategy.

**Manifest:**
```json
{
  "id": "sd-release-manager",
  "name": "Release Manager",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.release.ready", "topic.merge.conflict"],
  "mcp_permissions": {
    "management": ["workspace_get", "workspace_list"]
  }
}
```

**Listens on:** `agent.sd-release-manager.task`

**Responsibilities:**
- Creates release branches (`release/2026-03-20`) on request or schedule
- After `topic.commit.done`, merges feature branch into release branch
- Merge conflict → publishes `topic.merge.conflict` (back to developer)
- All features merged → publishes `topic.release.ready` (to Foreman/ops)

**Release branch workflow:**
```bash
# Create release branch from main
git checkout -b release/2026-03-20 main

# Merge each feature branch
git merge feat/TICK-001    # OK
git merge feat/TICK-002    # OK
git merge feat/TICK-003    # CONFLICT → topic.merge.conflict
```

**Merge conflict payload:**
```json
{
  "ticket_id": "TICK-003",
  "workspaceId": "ws-c3d4e5f6",
  "release_branch": "release/2026-03-20",
  "conflicting_files": ["src/api-server.ts"],
  "message": "Merge conflict with feat/TICK-001 on src/api-server.ts"
}
```

Developer receives this, resolves conflict in their worktree, re-commits. Committer re-triggers merge attempt.

### sd-hub-publisher

**Role:** Publishes pipeline output (features, agents, teams) to the hub repo as a PR.

**Manifest:**
```json
{
  "id": "sd-hub-publisher",
  "name": "Hub Publisher",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.hub.published"],
  "mcp_permissions": {}
}
```

**Listens on:** `agent.sd-hub-publisher.task`

**Behavior:**
1. Receives workspace reference with hub artifacts
2. Creates feature branch on hub repo
3. Copies/commits artifacts
4. Creates PR
5. Publishes `topic.hub.published`

**Needs:** `GH_TOKEN` with push access to hub repo.

---

## 4. Foreman Workflow Changes

### Workflow E (revised)

Current Workflow E does everything (deploy_feature + notify). Revised version is a routing decision:

```
topic.commit.done → Foreman:
  1. Determine artifact type from payload/ticket
  2. Route:
     - Has release manager? → forward to agent.sd-release-manager.task
     - No release manager (immediate)? → forward to agent.sd-ops.task
     - Hub artifact? → forward to agent.sd-hub-publisher.task
     - Docs/config only? → notify user, done
  3. After topic.deploy.done → notify user of success
  4. After topic.deploy.failed → notify user of failure + offer PR alternative
```

### New Workflow F — Deployment notifications

```
topic.deploy.done → Foreman:
  - Notify user: "Feature X deployed successfully"
  - Call workspace_return() to free the workspace

topic.deploy.failed → Foreman:
  - Notify user: "Deploy failed, rolled back"
  - Keep workspace for debugging
  - Offer to create PR instead

topic.merge.conflict → Foreman:
  - Notify user: "Merge conflict on TICK-003, returning to developer"
```

---

## 5. NATS Topic Map

New topics introduced by this design:

| Topic | Publisher | Consumer | Payload |
|-------|-----------|----------|---------|
| `topic.commit.done` | sd-committer | Foreman | `{ ticket_id, feature_name?, workspaceId }` |
| `topic.release.ready` | sd-release-manager | Foreman → sd-ops | `{ release_branch, workspaceIds[], ticket_ids[] }` |
| `topic.merge.conflict` | sd-release-manager | Foreman → sd-developer | `{ ticket_id, workspaceId, conflicting_files[] }` |
| `topic.deploy.done` | sd-ops | Foreman | `{ ticket_id, workspaceIds[], artifact_type }` |
| `topic.deploy.failed` | sd-ops | Foreman | `{ ticket_id, workspaceIds[], error, rolled_back }` |
| `topic.hub.published` | sd-hub-publisher | Foreman | `{ ticket_id, pr_url }` |

Existing topics unchanged.

---

## 6. Pipeline Flow Examples

### Example A: Immediate feature deploy (no release manager)

```
1. PM approves TICK-010, calls workspace_create("nano-agent-team", "TICK-010")
   → worktree created: /data/workspaces/active/ws-x1/ (branch feat/TICK-010)
2. Architect writes spec
3. Developer works in /workspace/repo (= ws-x1 worktree)
4. Reviewer approves
5. Committer commits to feat/TICK-010
   → publishes topic.commit.done { ticket_id: "TICK-010", workspaceId: "ws-x1" }
6. Foreman receives, no release manager installed
   → sends to agent.sd-ops.task { action: "deploy", workspaceIds: ["ws-x1"] }
7. Ops agent: detects feature → deploy_feature → health_check
   → publishes topic.deploy.done
8. Foreman notifies user, calls workspace_return("ws-x1")
```

### Example B: Batch release with conflict

```
1. Release Manager creates release/2026-03-20 branch
2. TICK-011, TICK-012, TICK-013 each get worktrees, develop in parallel
3. TICK-011 commits → topic.commit.done → Foreman → sd-release-manager
   → merge feat/TICK-011 into release/2026-03-20 ✅
4. TICK-012 commits → same flow → merge ✅
5. TICK-013 commits → merge ❌ CONFLICT with TICK-011
   → topic.merge.conflict → Foreman notifies → Developer resolves
   → Re-commit → merge ✅
6. Release Manager: all merged → topic.release.ready
7. Foreman → sd-ops: deploy release/2026-03-20
8. Ops agent: docker build → container swap → health_check ✅
   → topic.deploy.done
9. Foreman notifies user, cleans up workspaces
```

### Example C: Hub artifact (new agent)

```
1. PM approves TICK-020, workspace_create("hub", "TICK-020")
2. Developer creates new agent (manifest.json + CLAUDE.md) in worktree
3. Committer commits
4. Foreman detects hub artifact → sends to sd-hub-publisher
5. Hub Publisher: git push feat/TICK-020 to hub remote, creates PR
   → topic.hub.published { pr_url: "https://github.com/.../pull/15" }
6. Foreman notifies user with PR link
```

---

## 7. Configuration

New `config.json` fields:

```json
{
  "workspaceRepos": {
    "nano-agent-team": "https://github.com/nano-agent-team/nano-agent-team.git",
    "hub": "https://github.com/nano-agent-team/hub.git"
  },
  "deployStrategy": "immediate"
}
```

`deployStrategy`:
- `"immediate"` — each commit triggers deploy directly (no release manager needed)
- `"batch"` — commits merge into release branch, deploy on release (requires sd-release-manager)

---

## 8. New Core MCP Tools

Added to management MCP server:

| Tool | Description |
|------|-------------|
| `workspace_create(repoType, ownerId?)` | Create worktree workspace |
| `workspace_get(workspaceId)` | Get workspace path + metadata |
| `workspace_find(ownerId)` | Find workspace by owner |
| `workspace_return(workspaceId)` | Return workspace (remove worktree) |
| `workspace_list()` | List active workspaces |
| `restart_self()` | Restart nano-agent-team container |
| `health_check()` | Check system health with timeout |

---

## 9. Migration Path

1. **Phase 1:** Implement workspace provider + agent-manager changes. sd-developer gets `workspace_source: "ticket"` instead of `project_workspace: true`.
2. **Phase 2:** Implement sd-ops agent. Foreman Workflow E routes to sd-ops for immediate deploys.
3. **Phase 3:** Implement sd-release-manager for batch release capability.
4. **Phase 4:** Implement sd-hub-publisher for hub repo publishing.

Each phase is independently deployable and testable.

---

## Out of Scope

- CI/CD integration (GitHub Actions) — future enhancement
- Multi-environment deployment (staging/production) — future
- Automated testing in pipeline (beyond health check) — future
- Workspace quotas or disk management — future
- `project_workspace` deprecation timeline — after Phase 1 is stable
