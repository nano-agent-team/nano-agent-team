# Workspace Provider & Deployment Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate self-dev pipeline agents into git worktrees and add a full deploy cycle (release manager, ops, hub publisher).

**Architecture:** New `WorkspaceProvider` service manages bare repos + git worktrees. Agents with `workspace_source: "ticket"` are **ephemeral** — a fresh container is created per NATS message with the worktree mounted at creation time (not persistent). Three new agents (sd-release-manager, sd-ops, sd-hub-publisher) handle merge, deploy, and hub publishing. Control plane handles post-restart health check via `pending-deploy.json`.

**Important architectural notes:**
- Agents with `workspace_source: "ticket"` get a **new container per task message**. The workspace is resolved from the message payload before container creation and mounted as a bind volume. After the task completes, the container is removed.
- MCP workspace tools go inside the existing `management` permission block in `mcp-gateway.ts` (no individual `canCallBuiltin` guards). Also add entries to `listBuiltinTools()`.
- The control plane container does NOT have `/workspace/repo`. Git operations for restart/rollback use the bare repo path in `data/workspaces/repos/`.
- sd-hub-publisher needs access to the `data/workspaces/active/` directory (bind mount) to read source worktree artifacts when copying to hub worktree.

**Tech Stack:** TypeScript, Node.js, Docker, git CLI, NATS JetStream, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-workspace-provider-deployment-pipeline-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/workspace-provider.ts` | Core service: bare repo management, worktree lifecycle, index |
| `src/__tests__/workspace-provider.test.ts` | Unit tests for workspace provider |
| `hub/agents/sd-release-manager/manifest.json` | Release manager agent manifest |
| `hub/agents/sd-release-manager/CLAUDE.md` | Release manager instructions |
| `hub/agents/sd-ops/manifest.json` | Ops agent manifest |
| `hub/agents/sd-ops/CLAUDE.md` | Ops agent instructions |
| `hub/agents/sd-hub-publisher/manifest.json` | Hub publisher agent manifest |
| `hub/agents/sd-hub-publisher/CLAUDE.md` | Hub publisher instructions |

### Modified files

| File | Changes |
|------|---------|
| `src/agent-registry.ts:24-84` | Add `workspace_source` to `AgentManifest` interface |
| `src/agent-manager.ts:788-819` | Add `workspace_source: "ticket"` mounting logic |
| `src/mcp-gateway.ts:648-713` | Add workspace + restart + health_check MCP tools |
| `src/api-server.ts:877-1017` | Add `/internal/workspaces/*` + `/internal/restart` endpoints |
| `src/index.ts:110-250` | Init workspace provider on startup, wire pending-deploy check |
| `src/config-service.ts:17-38` | Add `workspaceRepos` to `NanoConfig` interface |
| `hub/agents/sd-developer/manifest.json` | `project_workspace: true` → `workspace_source: "ticket"` |
| `hub/agents/sd-architect/manifest.json` | Same migration |
| `hub/agents/sd-reviewer/manifest.json` | Same migration |
| `hub/agents/sd-committer/manifest.json` | Same migration + add push instructions |
| `hub/agents/sd-developer/CLAUDE.md` | Add merge conflict resolution workflow |
| `hub/agents/sd-committer/CLAUDE.md` | Add push-only case after merge resolution |
| `hub/teams/self-dev-team/workflow.json` | Add new agents + bindings |
| `hub/teams/self-dev-team/team.json` | Add new agents to list |
| `hub/agents/sd-pm/CLAUDE.md` | Add `workspace_create` call on ticket approval |

---

## Task 1: Workspace Provider — Core Service

**Files:**
- Create: `src/workspace-provider.ts`
- Create: `src/__tests__/workspace-provider.test.ts`

This task implements the core workspace provider: bare repo cloning, worktree lifecycle, and index management. No REST/MCP yet — pure service with TypeScript API.

- [ ] **Step 1: Write test for WorkspaceProvider.create()**

```typescript
// src/__tests__/workspace-provider.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { WorkspaceProvider } from '../workspace-provider.js';

const TEST_DIR = path.join(os.tmpdir(), 'ws-provider-test-' + process.pid);

describe('WorkspaceProvider', () => {
  let provider: WorkspaceProvider;
  let bareRepoPath: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Create a local bare repo for testing (no network)
    bareRepoPath = path.join(TEST_DIR, 'test-repo.git');
    execSync(`git init --bare --initial-branch=main ${bareRepoPath}`);

    // Create a temp clone, add a commit, push to bare
    const tmpClone = path.join(TEST_DIR, 'tmp-clone');
    execSync(`git clone ${bareRepoPath} ${tmpClone}`);
    execSync('git checkout -b main', { cwd: tmpClone, stdio: 'pipe' }).toString(); // ensure main branch
    fs.writeFileSync(path.join(tmpClone, 'README.md'), '# Test');
    execSync('git add . && git commit -m "init"', { cwd: tmpClone });
    execSync('git push origin HEAD:main', { cwd: tmpClone });
    fs.rmSync(tmpClone, { recursive: true });

    provider = new WorkspaceProvider(TEST_DIR, {
      'test-repo': bareRepoPath,
    });
  });

  afterEach(() => {
    provider.shutdown();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a worktree workspace', async () => {
    const ws = await provider.create('test-repo', 'TICK-001');

    expect(ws.workspaceId).toMatch(/^ws-/);
    expect(ws.repoType).toBe('test-repo');
    expect(ws.ownerId).toBe('TICK-001');
    expect(ws.branch).toBe('feat/TICK-001');
    expect(ws.status).toBe('checked-out');
    expect(fs.existsSync(ws.path)).toBe(true);
    expect(fs.existsSync(path.join(ws.path, 'README.md'))).toBe(true);
  });

  it('finds workspace by owner', async () => {
    const ws = await provider.create('test-repo', 'TICK-002');
    const found = provider.findByOwner('TICK-002');
    expect(found?.workspaceId).toBe(ws.workspaceId);
  });

  it('returns workspace and cleans up', async () => {
    const ws = await provider.create('test-repo', 'TICK-003');
    provider.returnWorkspace(ws.workspaceId);

    expect(fs.existsSync(ws.path)).toBe(false);
    expect(provider.get(ws.workspaceId)).toBeUndefined();
  });

  it('lists all workspaces', async () => {
    await provider.create('test-repo', 'TICK-004');
    await provider.create('test-repo', 'TICK-005');

    const all = provider.list();
    expect(all).toHaveLength(2);
  });

  it('throws on unknown repoType', async () => {
    await expect(provider.create('unknown-repo', 'TICK-006'))
      .rejects.toThrow('Unknown repoType');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/workspace-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WorkspaceProvider**

```typescript
// src/workspace-provider.ts
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { nanoid } from 'nanoid';

import { logger } from './logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkspaceMetadata {
  workspaceId: string;
  path: string;
  repoType: string;
  branch: string;
  ownerId: string;
  status: 'checked-out' | 'returned';
  createdAt: string;
}

// ─── Index persistence ──────────────────────────────────────────────────────

type WorkspaceIndex = Record<string, WorkspaceMetadata>;

function loadIndex(indexPath: string): WorkspaceIndex {
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as WorkspaceIndex;
  } catch {
    return {};
  }
}

function saveIndex(indexPath: string, index: WorkspaceIndex): void {
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// ─── WorkspaceProvider ──────────────────────────────────────────────────────

export class WorkspaceProvider {
  private readonly baseDir: string;
  private readonly reposDir: string;
  private readonly activeDir: string;
  private readonly indexPath: string;
  private readonly repoUrls: Record<string, string>;
  private index: WorkspaceIndex;
  private fetchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(baseDir: string, repoUrls: Record<string, string>) {
    this.baseDir = baseDir;
    this.reposDir = path.join(baseDir, 'repos');
    this.activeDir = path.join(baseDir, 'active');
    this.indexPath = path.join(baseDir, 'index.json');
    this.repoUrls = repoUrls;

    fs.mkdirSync(this.reposDir, { recursive: true });
    fs.mkdirSync(this.activeDir, { recursive: true });

    this.index = loadIndex(this.indexPath);
  }

  /** Start periodic fetch (every 5 min) */
  startPeriodicFetch(): void {
    if (this.fetchTimer) return;
    this.fetchTimer = setInterval(() => this.fetchAll(), 5 * 60 * 1000);
  }

  shutdown(): void {
    if (this.fetchTimer) {
      clearInterval(this.fetchTimer);
      this.fetchTimer = null;
    }
  }

  /** Ensure bare repo exists for repoType, clone if needed */
  private ensureBareRepo(repoType: string): string {
    const url = this.repoUrls[repoType];
    if (!url) throw new Error(`Unknown repoType: ${repoType}`);

    const repoDir = path.join(this.reposDir, `${repoType}.git`);
    if (fs.existsSync(repoDir)) return repoDir;

    // Check if URL is local path or remote
    if (fs.existsSync(url)) {
      // Local bare repo — just reference it directly
      logger.info({ repoType, url }, 'Using local bare repo');
      return url;
    }

    logger.info({ repoType, url }, 'Cloning bare repo (first time, may be slow)');
    execSync(`git clone --bare "${url}" "${repoDir}"`, {
      stdio: 'pipe',
      timeout: 120_000,
    });
    return repoDir;
  }

  /** Fetch all bare repos */
  private fetchAll(): void {
    for (const repoType of Object.keys(this.repoUrls)) {
      const repoDir = path.join(this.reposDir, `${repoType}.git`);
      if (!fs.existsSync(repoDir)) continue;
      try {
        execSync('git fetch --all --prune', { cwd: repoDir, stdio: 'pipe', timeout: 30_000 });
        logger.debug({ repoType }, 'Bare repo fetched');
      } catch (err) {
        logger.warn({ repoType, err }, 'Failed to fetch bare repo');
      }
    }
  }

  /** Create a new worktree workspace */
  async create(repoType: string, ownerId: string, branch?: string): Promise<WorkspaceMetadata> {
    const repoDir = this.ensureBareRepo(repoType);
    const workspaceId = `ws-${nanoid(8)}`;
    const branchName = branch ?? `feat/${ownerId}`;
    const worktreePath = path.join(this.activeDir, workspaceId);

    execSync(
      `git worktree add "${worktreePath}" -b "${branchName}" main`,
      { cwd: repoDir, stdio: 'pipe', timeout: 30_000 },
    );

    const meta: WorkspaceMetadata = {
      workspaceId,
      path: worktreePath,
      repoType,
      branch: branchName,
      ownerId,
      status: 'checked-out',
      createdAt: new Date().toISOString(),
    };

    this.index[workspaceId] = meta;
    saveIndex(this.indexPath, this.index);

    logger.info({ workspaceId, repoType, ownerId, branch: branchName }, 'Workspace created');
    return meta;
  }

  /** Get workspace by ID */
  get(workspaceId: string): WorkspaceMetadata | undefined {
    return this.index[workspaceId];
  }

  /** Find workspace by owner ID */
  findByOwner(ownerId: string): WorkspaceMetadata | undefined {
    return Object.values(this.index).find(
      (ws) => ws.ownerId === ownerId && ws.status === 'checked-out',
    );
  }

  /** List all active workspaces */
  list(): WorkspaceMetadata[] {
    return Object.values(this.index).filter((ws) => ws.status === 'checked-out');
  }

  /** Return workspace — remove worktree, conditionally delete branch */
  returnWorkspace(workspaceId: string): void {
    const ws = this.index[workspaceId];
    if (!ws) {
      logger.warn({ workspaceId }, 'Workspace not found for return');
      return;
    }

    const repoDir = this.ensureBareRepo(ws.repoType);

    // Remove worktree
    try {
      execSync(`git worktree remove "${ws.path}" --force`, {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 10_000,
      });
    } catch (err) {
      logger.warn({ workspaceId, err }, 'Failed to remove worktree, cleaning up manually');
      fs.rmSync(ws.path, { recursive: true, force: true });
      execSync('git worktree prune', { cwd: repoDir, stdio: 'pipe' });
    }

    // Delete branch only if merged
    try {
      const merged = execSync('git branch --merged main', {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      if (merged.includes(ws.branch)) {
        execSync(`git branch -D "${ws.branch}"`, { cwd: repoDir, stdio: 'pipe' });
        logger.info({ workspaceId, branch: ws.branch }, 'Branch deleted (merged)');
      } else {
        logger.info({ workspaceId, branch: ws.branch }, 'Branch preserved (not merged)');
      }
    } catch {
      // Branch may not exist anymore — that's fine
    }

    delete this.index[workspaceId];
    saveIndex(this.indexPath, this.index);

    logger.info({ workspaceId }, 'Workspace returned');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/workspace-provider.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/workspace-provider.ts src/__tests__/workspace-provider.test.ts
git commit -m "feat: add WorkspaceProvider core service with git worktree management"
```

---

## Task 2: Internal REST Endpoints for Workspaces

**Files:**
- Modify: `src/api-server.ts`
- Modify: `src/index.ts`

Wire the WorkspaceProvider into the API server with REST endpoints under `/internal/workspaces/*`.

- [ ] **Step 1: Add WorkspaceProvider to api-server options**

In `src/api-server.ts`, find the `ApiServerOptions` interface (or equivalent options parameter) and add:

```typescript
workspaceProvider?: WorkspaceProvider;
```

Pass it from `src/index.ts` after instantiation.

- [ ] **Step 2: Add /internal/workspaces REST endpoints**

In `src/api-server.ts`, after the existing `/internal` routes (after line ~1017), add:

```typescript
// ─── Workspace Provider endpoints ─────────────────────────────────────
if (workspaceProvider) {
  app.post('/internal/workspaces', async (req: Request, res: Response) => {
    try {
      const { repoType, ownerId, branch } = req.body as {
        repoType: string;
        ownerId?: string;
        branch?: string;
      };
      if (!repoType) {
        res.status(400).json({ error: 'repoType is required' });
        return;
      }
      const ws = await workspaceProvider.create(repoType, ownerId ?? '', branch);
      res.json(ws);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/internal/workspaces', (_req: Request, res: Response) => {
    res.json(workspaceProvider.list());
  });

  app.get('/internal/workspaces/by-owner/:ownerId', (req: Request, res: Response) => {
    const ws = workspaceProvider.findByOwner(req.params.ownerId);
    if (!ws) {
      res.status(404).json({ error: 'No workspace found for owner' });
      return;
    }
    res.json(ws);
  });

  app.get('/internal/workspaces/:id', (req: Request, res: Response) => {
    const ws = workspaceProvider.get(req.params.id);
    if (!ws) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json(ws);
  });

  app.delete('/internal/workspaces/:id', (req: Request, res: Response) => {
    workspaceProvider.returnWorkspace(req.params.id);
    res.json({ ok: true });
  });
}
```

- [ ] **Step 3: Initialize WorkspaceProvider in index.ts**

In `src/index.ts`, after config loading and before API server start:

```typescript
import { WorkspaceProvider } from './workspace-provider.js';

// After configService init:
const config = configService.load();
const workspaceRepos = (config as Record<string, unknown>).workspaceRepos as
  Record<string, string> | undefined;

let workspaceProvider: WorkspaceProvider | undefined;
if (workspaceRepos && Object.keys(workspaceRepos).length > 0) {
  const wsDir = path.join(DATA_DIR, 'workspaces');
  workspaceProvider = new WorkspaceProvider(wsDir, workspaceRepos);
  workspaceProvider.startPeriodicFetch();
  logger.info({ repos: Object.keys(workspaceRepos) }, 'Workspace provider initialized');
}

// Pass to API server:
// Add workspaceProvider to the createApiServer() call
```

Add `workspaceProvider.shutdown()` to the shutdown handler.

- [ ] **Step 4: Run existing tests to ensure no regression**

Run: `npx vitest run`
Expected: All existing tests pass

- [ ] **Step 5: Commit**

```bash
git add src/api-server.ts src/index.ts
git commit -m "feat: add /internal/workspaces REST endpoints"
```

---

## Task 3: Workspace MCP Tools

**Files:**
- Modify: `src/mcp-gateway.ts`

Add workspace management MCP tools to the management namespace.

- [ ] **Step 1: Add workspace tools to mcp-gateway.ts**

In `src/mcp-gateway.ts`, inside `buildMcpServer()`, find the existing management block `if (opts && permissions['management'] !== undefined)` (line ~487). Add workspace tools INSIDE this block, after the existing `deploy_feature` tool. Do NOT wrap each tool in its own `canCallBuiltin` guard — the management block handles access control.

Also add corresponding entries to `listBuiltinTools()` (line ~965) so MCP tools/list includes them.

```typescript
// Inside the management block, after deploy_feature:
  server.tool(
    'workspace_create',
    'Create an isolated git worktree workspace for a ticket. Returns workspaceId and path.',
    {
      repoType: z.string().describe('Repository type (e.g., "nano-agent-team", "hub")'),
      ownerId: z.string().optional().describe('Owner ID (typically ticket_id)'),
      branch: z.string().optional().describe('Branch name (defaults to feat/{ownerId})'),
    },
    async ({ repoType, ownerId, branch }) => {
      const res = await fetch(
        `http://localhost:${opts.apiPort}/internal/workspaces`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoType, ownerId, branch }),
        },
      );
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );
}

  server.tool(
    'workspace_get',
    'Get workspace metadata and path by workspace ID.',
    { workspaceId: z.string() },
    async ({ workspaceId }) => {
      const res = await fetch(
        `http://localhost:${opts.apiPort}/internal/workspaces/${workspaceId}`,
      );
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );
}

  server.tool(
    'workspace_find',
    'Find workspace by owner ID (typically ticket_id).',
    { ownerId: z.string() },
    async ({ ownerId }) => {
      const res = await fetch(
        `http://localhost:${opts.apiPort}/internal/workspaces/by-owner/${ownerId}`,
      );
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );
}

  server.tool(
    'workspace_return',
    'Return a workspace — removes worktree and optionally deletes merged branch.',
    { workspaceId: z.string() },
    async ({ workspaceId }) => {
      const res = await fetch(
        `http://localhost:${opts.apiPort}/internal/workspaces/${workspaceId}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );
}

  server.tool(
    'workspace_list',
    'List all active workspaces.',
    {},
    async () => {
      const res = await fetch(
        `http://localhost:${opts.apiPort}/internal/workspaces`,
      );
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/mcp-gateway.ts
git commit -m "feat: add workspace management MCP tools"
```

---

## Task 4: Agent Manager — workspace_source: "ticket"

**Files:**
- Modify: `src/agent-registry.ts`
- Modify: `src/agent-manager.ts`

Agents with `workspace_source: "ticket"` use an **ephemeral container per task message**. A fresh container is created for each NATS message, with the worktree bind-mounted at creation time. The container is removed after the task completes.

- [ ] **Step 1: Add workspace_source to AgentManifest**

In `src/agent-registry.ts`, find the `AgentManifest` interface (line ~24) and add:

```typescript
/** Mount worktree from workspace provider based on ticket_id in NATS payload.
 *  When set, agent runs as ephemeral: new container per task, workspace resolved from message payload. */
workspace_source?: 'ticket';
```

- [ ] **Step 2: Add ephemeral agent handling in agent-manager.ts**

The current architecture: agents start once and receive multiple messages (persistent containers). For `workspace_source: "ticket"`, the flow changes:

1. NATS message arrives at agent entrypoint
2. Agent-manager intercepts (instead of forwarding to running container)
3. Resolves workspace from message payload (`ticket_id` → workspace provider lookup)
4. Creates a **fresh container** with worktree bind-mounted as `/workspace/repo:rw`
5. Sends the NATS message to the new container
6. Container processes the task, then exits
7. Agent-manager cleans up the container

In `src/agent-manager.ts`, find the message dispatch code (where NATS messages are forwarded to agent containers). Add a branch for `workspace_source: "ticket"`:

```typescript
// In the NATS message handler for agent entrypoints:
if (agent.manifest.workspace_source === 'ticket') {
  // Ephemeral: resolve workspace, create fresh container, run task, cleanup
  const payload = JSON.parse(codec.decode(msg.data) as string) as {
    ticket_id?: string;
    workspaceId?: string;
  };
  const ticketId = payload.ticket_id;
  if (!ticketId) {
    logger.warn({ agentId }, 'workspace_source: ticket but no ticket_id in payload');
    msg.nak();
    return;
  }

  const apiPort = process.env.API_PORT ?? '3001';
  const wsRes = await fetch(`http://localhost:${apiPort}/internal/workspaces/by-owner/${ticketId}`);
  if (!wsRes.ok) {
    logger.warn({ agentId, ticketId }, 'Workspace not found, nacking message');
    msg.nak();
    return;
  }
  const ws = (await wsRes.json()) as { path: string; workspaceId: string };

  // Build env + binds with workspace mount
  const { env, binds } = this.buildAgentEnvAndBinds(agent);
  const hostWsPath = ws.path.replace(DATA_DIR, hostDataDir);
  binds.push(`${hostWsPath}:/workspace/repo:rw`);

  // Create ephemeral container, send message, wait for completion
  // Use existing createContainer() pattern but with unique container name
  const ephemeralName = `nano-agent-${agentId}-${ticketId}`;
  // ... create container with binds, start, attach message, wait for exit, remove
}
```

The exact implementation depends on how `createContainer()` / `startContainer()` work in the codebase. The key point: **workspace_source: "ticket" agents are NOT started at system boot** — they are started per-message and stopped after task completion.

- [ ] **Step 3: Skip workspace_source agents during startup**

In the agent startup loop (where agents are started at system boot), skip agents with `workspace_source: "ticket"`:

```typescript
if (agent.manifest.workspace_source === 'ticket') {
  logger.info({ agentId }, 'Skipping startup for ephemeral workspace agent');
  continue; // Will be started per-message by the NATS handler
}
```

- [ ] **Step 4: Register NATS consumer for ephemeral agents**

Even though the container doesn't start at boot, the NATS consumer must be registered so messages are queued. The agent-manager must set up a pull consumer for ephemeral agents that triggers container creation on message arrival.

- [ ] **Step 4: Run type check + existing tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent-registry.ts src/agent-manager.ts
git commit -m "feat: add workspace_source ticket support in agent-manager"
```

---

## Task 5: restart_self + health_check + pending-deploy

**Files:**
- Modify: `src/api-server.ts`
- Modify: `src/index.ts`

Implement the graceful drain restart with post-restart health verification.

- [ ] **Step 1: Add /internal/restart endpoint**

In `src/api-server.ts`, add:

```typescript
app.post('/internal/restart', async (req: Request, res: Response) => {
  const deployContext = req.body as {
    ticket_id?: string;
    workspaceId?: string;
  } | undefined;

  // Write pending-deploy context for post-restart verification
  if (deployContext?.ticket_id) {
    const pendingPath = path.join(DATA_DIR, 'pending-deploy.json');
    // Get current main commit from bare repo (control plane does NOT have /workspace/repo)
    const bareRepoDir = path.join(DATA_DIR, 'workspaces', 'repos', 'nano-agent-team.git');
    const mainCommit = (() => {
      try {
        return execSync('git rev-parse main', { cwd: bareRepoDir, encoding: 'utf8' }).trim();
      } catch { return 'unknown'; }
    })();
    fs.writeFileSync(pendingPath, JSON.stringify({
      ...deployContext,
      previousMainCommit: mainCommit,
      requestedAt: new Date().toISOString(),
    }));
  }

  res.json({ ok: true, message: 'Restart scheduled' });

  // Graceful shutdown after response is sent
  setTimeout(async () => {
    logger.info('Graceful restart: draining NATS and stopping agents...');
    try {
      await manager.stopAll();          // stop agent containers
      await nc?.drain();                // drain NATS
      server.close();                   // close HTTP
      logger.info('Graceful restart: exiting. Docker will restart.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Graceful restart failed, forcing exit');
      process.exit(1);
    }
  }, 500);
});
```

Note: `manager`, `nc`, `server` need to be accessible — either pass them as options or use closure references.

- [ ] **Step 2: Add restart_self and health_check MCP tools**

In `src/mcp-gateway.ts`, add inside the management block (after workspace tools):

```typescript
  server.tool(
    'restart_self',
    'Trigger graceful restart of the control plane. Drains NATS, stops agents, exits. Docker restart policy recovers. Pass deployContext for post-restart health verification.',
    {
      ticket_id: z.string().optional(),
      workspaceId: z.string().optional(),
    },
    async ({ ticket_id, workspaceId }) => {
      const res = await fetch(
        `http://localhost:${opts.apiPort}/internal/restart`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket_id, workspaceId }),
        },
      );
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );
}

  server.tool(
    'health_check',
    'Check system health with timeout.',
    { timeout_ms: z.number().optional().describe('Timeout in ms (default 10000)') },
    async ({ timeout_ms }) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout_ms ?? 10_000);
        const res = await fetch(
          `http://localhost:${opts.apiPort}/api/health`,
          { signal: controller.signal },
        );
        clearTimeout(timer);
        const data = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }] };
      }
    },
  );
}
```

- [ ] **Step 3: Add post-restart health check in index.ts**

In `src/index.ts`, after startup is complete (after API server starts listening), add:

```typescript
// ─── Post-restart deploy verification ──────────────────────────────────
const pendingDeployPath = path.join(DATA_DIR, 'pending-deploy.json');
if (fs.existsSync(pendingDeployPath)) {
  logger.info('Post-restart: found pending-deploy.json, running health verification');
  try {
    const pending = JSON.parse(fs.readFileSync(pendingDeployPath, 'utf8')) as {
      ticket_id: string;
      workspaceId: string;
      previousMainCommit: string;
    };

    // Self-test: check health endpoint responds
    const healthRes = await fetch(`http://localhost:${API_PORT}/api/health`);
    const health = await healthRes.json();

    if (healthRes.ok && health.status === 'ok') {
      logger.info({ ticket_id: pending.ticket_id }, 'Post-restart health check PASSED');
      // Publish deploy success
      if (nc) {
        import { codec } from './nats-client.js';  // use existing codec, not dynamic import
        nc.publish('topic.deploy.done', codec.encode({
          ticket_id: pending.ticket_id,
          workspaceId: pending.workspaceId,
          artifact_type: 'core',
        }));
      }
    } else {
      logger.error({ health }, 'Post-restart health check FAILED — rolling back');
      // Rollback: git revert HEAD on bare repo's main branch
      const bareRepoDir = path.join(DATA_DIR, 'workspaces', 'repos', 'nano-agent-team.git');
      try {
        // Create temp worktree for revert operation
        const revertDir = path.join(DATA_DIR, 'workspaces', 'active', 'revert-tmp');
        execSync(`git worktree add "${revertDir}" main`, { cwd: bareRepoDir, stdio: 'pipe' });
        execSync('git revert HEAD --no-edit', { cwd: revertDir, stdio: 'pipe' });
        execSync(`git worktree remove "${revertDir}"`, { cwd: bareRepoDir, stdio: 'pipe' });
        logger.info('Rollback: git revert HEAD done');
      } catch {
        logger.error('Rollback: git revert failed');
      }
      if (nc) {
        import { codec } from './nats-client.js';  // use existing codec, not dynamic import
        nc.publish('topic.deploy.failed', codec.encode({
          ticket_id: pending.ticket_id,
          workspaceId: pending.workspaceId,
          error: 'Health check failed after restart, rolled back',
        }));
      }
    }

    fs.unlinkSync(pendingDeployPath);
  } catch (err) {
    logger.error({ err }, 'Post-restart verification failed');
    try { fs.unlinkSync(pendingDeployPath); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api-server.ts src/mcp-gateway.ts src/index.ts
git commit -m "feat: add restart_self, health_check, and post-restart deploy verification"
```

---

## Task 6: Config Schema — workspaceRepos

**Files:**
- Modify: `src/config-service.ts`

- [ ] **Step 1: Add workspaceRepos to NanoConfig**

In `src/config-service.ts`, find the `NanoConfig` interface and add:

```typescript
/** Bare repo URLs for workspace provider (repoType → git URL) */
workspaceRepos?: Record<string, string>;
```

- [ ] **Step 2: Commit**

```bash
git add src/config-service.ts
git commit -m "feat: add workspaceRepos to NanoConfig schema"
```

---

## Task 7: New Agent — sd-release-manager

**Files:**
- Create: `hub/agents/sd-release-manager/manifest.json`
- Create: `hub/agents/sd-release-manager/CLAUDE.md`

- [ ] **Step 1: Create manifest.json**

```json
{
  "id": "sd-release-manager",
  "name": "Self-Dev Release Manager",
  "model": "claude-sonnet-4-6",
  "session_type": "stateless",
  "workspace_source": "ticket",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.release.ready", "topic.merge.conflict"],
  "mcp_permissions": {
    "management": ["workspace_get", "workspace_return"],
    "tickets": ["get", "comment"]
  }
}
```

Note: `workspace_source: "ticket"` means release manager gets a fresh ephemeral container per task with the ticket's worktree mounted at `/workspace/repo`.
```

- [ ] **Step 2: Create CLAUDE.md**

Write release manager instructions following the spec:
- Merge workflow: fetch main → merge into feature branch → push to main
- Conflict handling: leave markers, comment on ticket, publish topic.merge.conflict
- Cleanup: on topic.deploy.done, call workspace_return
- Rules: never force-push, never modify main directly except via fast-forward merge

Key sections:
1. Identity + Role
2. Environment (`/workspace/repo` = ticket's worktree)
3. Available MCP tools
4. Workflow on `topic.commit.done`
5. Workflow on `topic.deploy.done` (cleanup)
6. Merge conflict escalation flow
7. Rules

- [ ] **Step 3: Commit**

```bash
git add hub/agents/sd-release-manager/
git commit -m "feat: add sd-release-manager agent (merge + conflict escalation)"
```

---

## Task 8: New Agent — sd-ops

**Files:**
- Create: `hub/agents/sd-ops/manifest.json`
- Create: `hub/agents/sd-ops/CLAUDE.md`

- [ ] **Step 1: Create manifest.json**

```json
{
  "id": "sd-ops",
  "name": "Self-Dev Operations Agent",
  "model": "claude-sonnet-4-6",
  "session_type": "stateless",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.deploy.done", "topic.deploy.failed", "topic.hub.deploy"],
  "mcp_permissions": {
    "management": ["deploy_feature", "restart_self", "health_check"],
    "tickets": ["get", "comment"]
  }
}
```

Note: sd-ops does NOT have `workspace_source: "ticket"` — it uses MCP tools, not direct workspace access.

- [ ] **Step 2: Create CLAUDE.md**

Write ops agent instructions following the spec:
- Artifact detection: check changed files on main after merge
- Feature deploy: `deploy_feature()` + verify
- Core deploy: `restart_self({ ticket_id, workspaceId })` — control plane handles the rest
- Hub artifact: publish `topic.hub.deploy`
- Mixed: hub → feature → core (core last)
- Never merge, never modify code

Key sections:
1. Identity + Role
2. Available MCP tools
3. Workflow on `topic.release.ready`
4. Artifact detection rules
5. Deploy procedures per type
6. Error handling

- [ ] **Step 3: Commit**

```bash
git add hub/agents/sd-ops/
git commit -m "feat: add sd-ops agent (build, deploy, health check)"
```

---

## Task 9: New Agent — sd-hub-publisher

**Files:**
- Create: `hub/agents/sd-hub-publisher/manifest.json`
- Create: `hub/agents/sd-hub-publisher/CLAUDE.md`

- [ ] **Step 1: Create manifest.json**

```json
{
  "id": "sd-hub-publisher",
  "name": "Self-Dev Hub Publisher",
  "model": "claude-sonnet-4-6",
  "session_type": "stateless",
  "entrypoints": ["inbox", "task"],
  "publish_topics": ["topic.hub.published"],
  "mcp_permissions": {
    "management": ["workspace_create", "workspace_return", "workspace_get"],
    "tickets": ["get", "comment"]
  }
}
```

Note: sd-hub-publisher does NOT use `workspace_source: "ticket"` — it creates its own hub worktree via MCP tools. To access the source (nano-agent-team) worktree, it needs a bind mount of `data/workspaces/active/` as read-only. Add to manifest:

```json
"binds": ["${DATA_DIR}/workspaces/active:/workspaces/source:ro"]
```

This allows the publisher to read files from the ticket's worktree (path from `workspace_get` MCP call) and copy them into the hub worktree it creates. The agent-manager's bind mounting code needs to support the `binds` manifest field.
```

- [ ] **Step 2: Create CLAUDE.md**

Write hub publisher instructions:
- Create hub worktree: `workspace_create("hub", ticket_id)`
- Copy hub artifacts from ticket worktree (paths in NATS payload)
- Commit + push + `gh pr create`
- Cleanup: `workspace_return(hubWorkspaceId)`
- Publish `topic.hub.published { ticket_id, pr_url }`
- Needs GH_TOKEN (injected via env)

- [ ] **Step 3: Commit**

```bash
git add hub/agents/sd-hub-publisher/
git commit -m "feat: add sd-hub-publisher agent (PR on hub repo)"
```

---

## Task 10: Workflow.json + Team.json Updates

**Files:**
- Modify: `hub/teams/self-dev-team/workflow.json`
- Modify: `hub/teams/self-dev-team/team.json`

- [ ] **Step 1: Update workflow.json**

Add new agents to the agents list and add their bindings. Also add `merge_conflict` input to sd-developer and deploy notifications to foreman. Full updated workflow.json per spec Section 7.

Key additions:
- `sd-release-manager`: inputs `commit_done` + `deploy_done`, outputs `release_ready` + `merge_conflict`
- `sd-ops`: input `release_ready`, outputs `deploy_done` + `deploy_failed` + `hub_deploy`
- `sd-hub-publisher`: input `hub_deploy`, output `hub_published`
- `sd-developer`: add `merge_conflict` input
- `foreman`: add `deploy_failed` + `hub_published` inputs
- Remove `foreman` binding for `commit_done` (now goes to release manager)

- [ ] **Step 2: Update team.json**

Add new agents to the agents list:

```json
{
  "id": "self-dev-team",
  "name": "Self-Dev Team",
  "version": "0.2.0",
  "description": "Self-improvement pipeline with isolated workspaces and deployment.",
  "required_secrets": [],
  "agents": ["sd-pm", "sd-architect", "sd-developer", "sd-reviewer", "sd-committer", "sd-release-manager", "sd-ops", "sd-hub-publisher"]
}
```

- [ ] **Step 3: Commit**

```bash
git add hub/teams/self-dev-team/
git commit -m "feat: update self-dev-team workflow with release manager, ops, hub publisher"
```

---

## Task 11: Migrate Existing Agent Manifests

**Files:**
- Modify: `hub/agents/sd-developer/manifest.json`
- Modify: `hub/agents/sd-architect/manifest.json`
- Modify: `hub/agents/sd-reviewer/manifest.json`
- Modify: `hub/agents/sd-committer/manifest.json`

- [ ] **Step 1: Replace project_workspace with workspace_source in all four manifests**

For each of `sd-developer`, `sd-architect`, `sd-reviewer`, `sd-committer`:

Remove:
```json
"project_workspace": true,
```

Add:
```json
"workspace_source": "ticket",
```

- [ ] **Step 2: Commit**

```bash
git add hub/agents/sd-developer/manifest.json hub/agents/sd-architect/manifest.json \
  hub/agents/sd-reviewer/manifest.json hub/agents/sd-committer/manifest.json
git commit -m "feat: migrate sd-agents from project_workspace to workspace_source ticket"
```

---

## Task 12: Update Agent CLAUDE.md Files

**Files:**
- Modify: `hub/agents/sd-pm/CLAUDE.md`
- Modify: `hub/agents/sd-developer/CLAUDE.md`
- Modify: `hub/agents/sd-committer/CLAUDE.md`

- [ ] **Step 1: Update sd-pm CLAUDE.md**

Add to PM's approval workflow:

```markdown
### Workspace provisioning

After approving a ticket, provision a workspace before publishing downstream:

1. Determine repoType: check ticket body for hints (default: "nano-agent-team")
2. Call `workspace_create(repoType, ticket_id)`
3. Include `workspaceId` in the NATS payload:

\`\`\`bash
nats pub topic.ticket.approved '{"ticket_id": "TICK-XXX", "workspaceId": "ws-xxx"}'
\`\`\`
```

Add `workspace_create` to PM's mcp_permissions in manifest:

```json
"mcp_permissions": {
  "management": ["workspace_create"],
  "tickets": ["list", "get", "approve", "reject", "create", "update", "comment"]
}
```

- [ ] **Step 2: Update sd-developer CLAUDE.md**

Add merge conflict handling section:

```markdown
### Handling merge conflicts (topic.merge.conflict)

When you receive a message on `topic.merge.conflict`:

1. The worktree contains unresolved merge conflict markers (<<<< HEAD / >>>>)
2. Read the ticket comment from Release Manager for details on which files conflict
3. Open conflicting files, understand both sides of the conflict
4. Resolve all conflicts — remove all conflict markers
5. `git add <resolved-files>` + `git commit` (this creates the merge commit)
6. Run tests to verify the resolved code works
7. Publish `topic.dev.done` as normal — the ticket goes back through review
```

- [ ] **Step 3: Update sd-committer CLAUDE.md**

Add push-only case:

```markdown
### Push-only case (after merge conflict resolution)

If the latest commit is a merge commit (check with `git log --oneline -1 --merges`),
the developer already resolved the merge and committed. In this case:

1. Do NOT run `git add` or `git commit` — the merge commit is already done
2. Push the branch: `git push origin feat/TICK-XXX`
3. Publish `topic.commit.done` as normal
```

- [ ] **Step 4: Commit**

```bash
git add hub/agents/sd-pm/manifest.json hub/agents/sd-pm/CLAUDE.md \
  hub/agents/sd-developer/CLAUDE.md hub/agents/sd-committer/CLAUDE.md
git commit -m "feat: update sd-pm, sd-developer, sd-committer for workspace workflow"
```

---

## Task 13: Integration Test

**Files:**
- Create: `src/__tests__/workspace-integration.test.ts` (optional, if time permits)

- [ ] **Step 1: Write integration test**

Test the full flow: create workspace → mount in agent → return workspace.

This test verifies:
- WorkspaceProvider creates worktree from a local bare repo
- REST endpoints respond correctly
- Agent-manager resolves workspace path from ticket_id

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Final commit**

```bash
git add src/__tests__/workspace-integration.test.ts
git commit -m "test: add workspace provider integration test"
```

---

## Task 14: Deploy + Verify

- [ ] **Step 1: Rebuild agent image** (if container/Dockerfile changed)

```bash
cd container && docker build -t nano-agent:latest .
```

- [ ] **Step 2: Rebuild main stack**

```bash
/nat-rebuild
```

- [ ] **Step 3: Verify workspace provider initialized**

Check logs for: `Workspace provider initialized`

If `workspaceRepos` not in config yet, add via dashboard settings or directly:

```bash
curl -X POST http://localhost:3001/internal/config -H 'Content-Type: application/json' \
  -d '{"path": "workspaceRepos", "value": {"nano-agent-team": "https://github.com/owner/nano-agent-team.git", "hub": "https://github.com/owner/hub.git"}}'
```

- [ ] **Step 4: Test workspace creation**

```bash
curl -X POST http://localhost:3001/internal/workspaces \
  -H 'Content-Type: application/json' \
  -d '{"repoType": "nano-agent-team", "ownerId": "test-001"}'
```

Expected: `{ "workspaceId": "ws-...", "path": "...", ... }`

- [ ] **Step 5: Verify new agents installed**

After reinstalling self-dev-team:

```bash
curl http://localhost:3001/api/health | python3 -m json.tool
```

Check for sd-release-manager, sd-ops, sd-hub-publisher in agent list.

- [ ] **Step 6: Cleanup test workspace**

```bash
curl -X DELETE http://localhost:3001/internal/workspaces/{workspaceId}
```
