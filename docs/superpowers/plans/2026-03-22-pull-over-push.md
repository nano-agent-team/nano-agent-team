# Pull-over-Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unreliable NATS-only pipeline dispatch with AlarmClock-driven scrum-master agent that polls the ticketing system, claims work, dispatches it, and detects orphans.

**Architecture:** Simplify ticket statuses to 5 (idea/waiting/in_progress/done/rejected). Add deterministic runner container (no LLM) for scrum-master agent. Scrum-master polls tickets, claims via optimistic locking (expected_status), dispatches by publishing NATS to agent.{id}.task, and detects orphaned in_progress tickets via heartbeat matching.

**Tech Stack:** TypeScript, Node.js 20, NATS JetStream, SQLite (better-sqlite3), Docker

**Spec:** `docs/superpowers/specs/2026-03-22-pull-over-push-design.md`

---

## File Structure

### Modified files
| File | Responsibility | Changes |
|------|----------------|---------|
| `src/tickets/types.ts` | Abstract ticket types | Simplify AbstractStatus, add expected_status to UpdateTicketData, update STATUS_NATS_EVENTS |
| `src/tickets/local-provider.ts` | SQLite ticket CRUD | Add expected_status check in updateTicket, update LocalStatusMapper |
| `src/tickets/github-provider.ts` | GitHub Issues adapter | Update status label mappings |
| `src/db.ts` | Schema + migrations | Migrate status values, update CHECK constraint |
| `src/api-server.ts` | REST API | Pass expected_status, return 409 on conflict |
| `src/mcp-gateway.ts` | MCP tool definitions | Add expected_status to ticket_update Zod schema, expose ticketId in get_system_status |
| `src/agent-registry.ts` | Agent manifest types | Add handler field |
| `src/agent-manager.ts` | Container orchestration | Handle kind=deterministic (env, image), bootstrap alarm, expose ticketId in getStates |
| `container/agent-runner/src/index.ts` | LLM agent runtime | Add ticketId to heartbeat, remove poll env vars |
| `container/agent-runner/src/tickets-mcp-stdio.ts` | Stdio MCP server | Add expected_status to ticket_update Zod schema |
| `hub/teams/self-dev-team/workflow.json` | Pipeline definition | Add sd-scrum-master |
| `hub/agents/sd-*/CLAUDE.md` | Agent instructions | Update for waiting/in_progress status model |

### New files
| File | Responsibility |
|------|----------------|
| `container/deterministic-runner/Dockerfile` | Docker image for deterministic agents |
| `container/deterministic-runner/package.json` | Dependencies (nats, better-sqlite3, pino) |
| `container/deterministic-runner/tsconfig.json` | TypeScript config |
| `container/deterministic-runner/src/index.ts` | NATS consumer + handler dispatch |
| `container/deterministic-runner/src/types.ts` | HandlerContext interface |
| `container/deterministic-runner/src/handlers/scrum-master.ts` | Polling, claim, dispatch, orphan detection |
| `hub/agents/sd-scrum-master/manifest.json` | Scrum-master agent definition |

---

## Phase 0: Consolidate to main

### Task 1: Push and merge outstanding work

**Files:**
- No code changes — git operations only

**Context:** main has 2 unpushed commits (docs only). feat/workspace-provider has 26 commits (not ready to merge — large feature, separate concern). feat/pull-over-push has 2 spec commits.

- [ ] **Step 1: Push main to origin**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
git checkout main
git push origin main
```

- [ ] **Step 2: Rebase pull-over-push onto main**

```bash
git checkout feat/pull-over-push
git rebase main
```

- [ ] **Step 3: Verify clean state**

```bash
git status
git log --oneline main..HEAD
```

Expected: 2 commits (spec docs), no uncommitted changes.

---

## Phase 1: Status refactor + expected_status

### Task 2: Simplify AbstractStatus type

**Files:**
- Modify: `src/tickets/types.ts:10-17` (AbstractStatus)
- Modify: `src/tickets/types.ts:69-76` (UpdateTicketData)
- Modify: `src/tickets/types.ts:90-96` (STATUS_NATS_EVENTS)

- [ ] **Step 1: Update AbstractStatus**

Replace lines 10-17 in `src/tickets/types.ts`:
```typescript
export type AbstractStatus =
  | 'idea'
  | 'waiting'
  | 'in_progress'
  | 'done'
  | 'rejected';
```

- [ ] **Step 2: Add expected_status to UpdateTicketData**

Replace lines 69-76 in `src/tickets/types.ts`:
```typescript
export interface UpdateTicketData {
  title?: string;
  body?: string;
  status?: AbstractStatus;
  priority?: TicketPriority;
  assignee?: string;
  labels?: string[];
  /** Optimistic lock: only update if current status matches (GH-103). Returns 409 on mismatch. */
  expected_status?: AbstractStatus;
}
```

- [ ] **Step 3: Update STATUS_NATS_EVENTS**

Replace lines 90-96 in `src/tickets/types.ts`:
```typescript
export const STATUS_NATS_EVENTS: Partial<Record<AbstractStatus, string>> = {
  waiting:     'topic.ticket.waiting',
  in_progress: 'topic.ticket.claimed',
  done:        'topic.ticket.done',
  rejected:    'topic.ticket.rejected',
};
```

- [ ] **Step 4: Fix all TypeScript errors from AbstractStatus change**

Run: `cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team && npx tsc --noEmit 2>&1 | head -50`

Fix any imports or references to removed status values (`'new'`, `'approved'`, `'review'`, `'pending_input'`).

- [ ] **Step 5: Commit**

```bash
git add src/tickets/types.ts
git commit -m "refactor: simplify AbstractStatus to 5 states (GH-103)"
```

### Task 3: Update LocalStatusMapper

**Files:**
- Modify: `src/tickets/local-provider.ts` (LocalStatusMapper, updateTicket)

- [ ] **Step 1: Read current LocalStatusMapper**

Read the file to find the current native↔abstract status mappings. The mapper translates between DB native values and AbstractStatus.

- [ ] **Step 2: Update status mappings**

Update the mapper so:
- Native `'idea'` ↔ Abstract `'idea'`
- Native `'waiting'` ↔ Abstract `'waiting'`
- Native `'in_progress'` ↔ Abstract `'in_progress'`
- Native `'done'` ↔ Abstract `'done'`
- Native `'rejected'` ↔ Abstract `'rejected'`

Remove mappings for `'new'`, `'approved'`, `'spec_ready'`, `'review'`, `'verified'`, `'pending_input'`, `'epic'`.

- [ ] **Step 3: Update TicketProvider interface**

In `src/tickets/types.ts`, the `TicketProvider` interface's `updateTicket` method already receives `UpdateTicketData` which now includes `expected_status`. No interface change needed — the type flows through automatically.

Also update `TicketRegistry.updateTicket()` in `src/tickets/registry.ts` — it already passes the full `data` object to the provider, so `expected_status` flows through. No change needed.

- [ ] **Step 4: Add expected_status check to LocalTicketProvider.updateTicket**

In the `updateTicket` method (around line 120), add before the UPDATE query:

```typescript
// Optimistic lock (GH-103): reject if current status doesn't match expected
if (data.expected_status !== undefined) {
  if (existing.status !== statusMapper.toNative(data.expected_status)) {
    const err = new Error(`Status conflict: expected '${data.expected_status}' but found '${statusMapper.toAbstract(existing.status)}'`);
    (err as any).statusCode = 409;
    throw err;
  }
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/tickets/local-provider.ts
git commit -m "refactor: update LocalStatusMapper for 5-status model, add expected_status (GH-103)"
```

### Task 4: Update GitHub provider status mappings

**Files:**
- Modify: `src/tickets/github-provider.ts`

- [ ] **Step 1: Read current GitHub provider**

Read the file to find status label mappings.

- [ ] **Step 2: Update label↔status mappings**

Map GitHub labels to new statuses:
- Label `"idea"` → `'idea'`
- Label `"waiting"` → `'waiting'`
- Label `"in-progress"` → `'in_progress'`
- Label `"done"` → `'done'`
- Label `"rejected"` → `'rejected'`

Remove old label mappings.

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```bash
git add src/tickets/github-provider.ts
git commit -m "refactor: update GitHub provider status labels (GH-103)"
```

### Task 5: Migrate DB schema and data

**Files:**
- Modify: `src/db.ts:24` (CHECK constraint)

- [ ] **Step 1: Read current db.ts**

Find the CREATE TABLE and CHECK constraint.

- [ ] **Step 2: Update CHECK constraint**

Change the CHECK constraint on line 24 to:
```sql
CHECK(status IN ('idea','waiting','in_progress','done','rejected'))
```

- [ ] **Step 3: Add migration function**

SQLite CHECK constraints block UPDATEs to values not in the constraint. Since SQLite doesn't support `ALTER TABLE ... DROP CONSTRAINT`, we must recreate the table. Add a migration function that runs on startup (before the new CREATE TABLE):

```typescript
function migrateStatuses(db: Database): void {
  // Check if old statuses exist (needs migration)
  const hasOld = db.prepare("SELECT COUNT(*) as cnt FROM tickets WHERE status IN ('approved','spec_ready','review','verified','pending_input','epic','new')").get() as { cnt: number } | undefined;
  if (!hasOld || hasOld.cnt === 0) {
    // Also check if table exists at all
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tickets'").get();
    if (!tableExists) return; // Fresh DB, CREATE TABLE will handle it
    // Check if CHECK constraint needs updating (table exists but no old rows)
    // Recreate anyway to update CHECK constraint
  }

  // Recreate table with new CHECK constraint
  db.exec('BEGIN TRANSACTION');
  try {
    // 1. Create new table with updated CHECK
    db.exec(`CREATE TABLE IF NOT EXISTS tickets_new (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('idea','waiting','in_progress','done','rejected')),
      priority TEXT NOT NULL DEFAULT 'MED',
      type TEXT NOT NULL DEFAULT 'task',
      body TEXT, assigned_to TEXT, author TEXT,
      labels TEXT DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    // 2. Copy data with status mapping
    db.exec(`INSERT OR IGNORE INTO tickets_new
      SELECT id, title,
        CASE status
          WHEN 'approved' THEN 'waiting'
          WHEN 'spec_ready' THEN 'waiting'
          WHEN 'review' THEN 'waiting'
          WHEN 'verified' THEN 'done'
          WHEN 'pending_input' THEN 'waiting'
          WHEN 'epic' THEN 'idea'
          WHEN 'new' THEN 'idea'
          ELSE status
        END,
        priority, type, body, assigned_to, author, labels, created_at, updated_at
      FROM tickets`);
    // 3. Drop old, rename new
    db.exec('DROP TABLE tickets');
    db.exec('ALTER TABLE tickets_new RENAME TO tickets');
    db.exec('COMMIT');
    logger.info('Migrated ticket statuses to 5-state model');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

Call `migrateStatuses(db)` before the CREATE TABLE IF NOT EXISTS (so it runs on existing DBs). The function is idempotent — if old table doesn't exist or has no old statuses, it skips or just updates the CHECK constraint.

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/db.ts
git commit -m "refactor: migrate ticket statuses to 5-state model (GH-103)"
```

### Task 6: Update API server for expected_status

**Files:**
- Modify: `src/api-server.ts:760-794` (PATCH endpoint)

- [ ] **Step 1: Add expected_status to PATCH body parsing**

In the PATCH endpoint (line 765), add `expected_status` to the body type:
```typescript
const body = req.body as {
  title?: string; body?: string; status?: string; priority?: string;
  assigned_to?: string; labels?: string; changed_by?: string;
  expected_status?: string;  // Optimistic lock (GH-103)
};
```

- [ ] **Step 2: Pass expected_status to updateData**

Add to the updateData object (around line 778):
```typescript
...(body.expected_status !== undefined && { expected_status: body.expected_status as AbstractStatus }),
```

- [ ] **Step 3: Handle 409 Conflict response**

Add error handling in the catch block (around line 787):
```typescript
if (err instanceof Error && (err as any).statusCode === 409) {
  return res.status(409).json({ error: 'Status conflict', detail: err.message });
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/api-server.ts
git commit -m "feat: add expected_status optimistic lock to PATCH /api/tickets (GH-103)"
```

### Task 7: Update MCP tool Zod schemas

**Files:**
- Modify: `src/mcp-gateway.ts:329-350` (ticket_update tool)
- Modify: `container/agent-runner/src/tickets-mcp-stdio.ts:152-186` (ticket_update tool)

- [ ] **Step 1: Update mcp-gateway ticket_update schema**

Add `expected_status` to the Zod schema (around line 340):
```typescript
expected_status: z.string().optional().describe('Optimistic lock: only update if current status matches this value. Returns error on mismatch.'),
```

Update the status describe string:
```typescript
status: z.string().optional().describe('New status: idea | waiting | in_progress | done | rejected'),
```

Pass `expected_status` to the registry call:
```typescript
const ticket = await registry.updateTicket(ticket_id, {
  title, body,
  priority: priority as TicketPriority | undefined,
  assignee,
  status: status as AbstractStatus | undefined,
  expected_status: expected_status as AbstractStatus | undefined,
}, agentId);
```

- [ ] **Step 2: Update tickets-mcp-stdio ticket_update schema**

Add `expected_status` to the Zod schema in `container/agent-runner/src/tickets-mcp-stdio.ts`:
```typescript
expected_status: z.string().optional().describe('Optimistic lock: only update if current status matches. Returns error on mismatch.'),
```

Update the status describe string and pass `expected_status` in the HTTP PATCH body.

- [ ] **Step 3: Update mcp-gateway ticket_update description string**

Change the tool description from referencing old statuses to:
```
'Update ticket fields. Status transitions: waiting → in_progress (claim), in_progress → waiting (hand off to next agent), in_progress → done (complete).'
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/mcp-gateway.ts container/agent-runner/src/tickets-mcp-stdio.ts
git commit -m "feat: add expected_status to MCP ticket_update Zod schemas (GH-103)"
```

### Task 7.5: Update ticket_approve and ticket_reject tools

**Files:**
- Modify: `src/mcp-gateway.ts:353-365` (ticket_approve)
- Modify: `src/mcp-gateway.ts:368-375` (ticket_reject)
- Modify: `src/mcp-gateway.ts:936-940` (SSE tool listings)

- [ ] **Step 1: Update ticket_approve to set waiting + assigned_to**

Change the `ticket_approve` tool (line 353) to set `status: 'waiting'` instead of `'approved'`, and require `assignee`:
```typescript
server.tool(
  'ticket_approve',
  'Approve a ticket. Sets status to "waiting" with assigned_to for next pipeline agent.',
  {
    ticket_id: z.string().describe('Ticket ID'),
    assignee:  z.string().describe('Assign to this agent (e.g. "sd-architect")'),
  },
  async ({ ticket_id, assignee }) => {
    const ticket = await registry.updateTicket(ticket_id, { status: 'waiting', assignee }, agentId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(ticket, null, 2) }] };
  },
);
```

- [ ] **Step 2: Verify ticket_reject still works**

`ticket_reject` sets `status: 'rejected'` which is still valid. No change needed.

- [ ] **Step 3: Update SSE tool listings**

Update the tool descriptions in the SSE section (around lines 936-940) to match.

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/mcp-gateway.ts
git commit -m "refactor: ticket_approve sets waiting+assigned_to instead of approved (GH-103)"
```

### Task 8: Add ticketId to heartbeat + getStates

**Files:**
- Modify: `container/agent-runner/src/index.ts:134-139` (HeartbeatPayload)
- Modify: `container/agent-runner/src/index.ts:210-223` (publishHeartbeat)
- Modify: `src/agent-manager.ts:331-341` (getStates)

- [ ] **Step 1: Add ticketId to HeartbeatPayload**

Update the interface at line 134:
```typescript
interface HeartbeatPayload {
  agentId: string;
  ts: number;
  busy?: boolean;
  task?: string;
  ticketId?: string;
}
```

- [ ] **Step 2: Track ticketId in agent state**

Add a module-level variable near `currentTask`:
```typescript
let currentTicketId: string | undefined;
```

Set it when extracting ticket_id from payload (around line 465):
```typescript
currentTicketId = ticketId;
```

Clear it when marking idle (around line 655):
```typescript
currentTicketId = undefined;
```

- [ ] **Step 3: Include ticketId in heartbeat**

Update `publishHeartbeat` to include `currentTicketId`:
```typescript
const payload: HeartbeatPayload = {
  agentId: AGENT_ID, ts: Date.now(),
  busy: isBusy,
  ...(currentTask ? { task: currentTask } : {}),
  ...(currentTicketId ? { ticketId: currentTicketId } : {}),
};
```

- [ ] **Step 4: Expose ticketId in agent-manager getStates**

In `src/agent-manager.ts`, add `ticketId` to the heartbeat state and `getStates()` return type (around line 331):
```typescript
getStates(): Array<{
  agentId: string;
  status: AgentStatus;
  restartCount: number;
  startedAt?: string;
  lastHeartbeat?: string;
  containerId?: string;
  busy?: boolean;
  task?: string;
  ticketId?: string;
  rollingOver?: boolean;
}> {
```

In `subscribeHeartbeats()` (line 824), add `ticketId` parsing at line 835:
```typescript
state.ticketId = (payload as any).ticketId ?? undefined;
```

Add `ticketId?: string` to the `AgentState` interface (wherever it's defined in agent-manager.ts).

Add `ticketId` to `getStates()` return (line 342):
```typescript
ticketId: s.ticketId,
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`
Run: `cd container/agent-runner && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/index.ts src/agent-manager.ts
git commit -m "feat: add ticketId to heartbeat payload and getStates (GH-103)"
```

### Task 9: Remove per-agent polling code

**Files:**
- Modify: `src/agent-registry.ts` (remove poll_interval, poll_statuses)
- Modify: `src/agent-manager.ts` (remove AGENT_POLL_* env var pass-through)
- Modify: `container/agent-runner/src/index.ts` (remove AGENT_POLL_* config)

- [ ] **Step 1: Remove poll fields from AgentManifest**

In `src/agent-registry.ts`, remove the `poll_interval` and `poll_statuses` fields added earlier in this branch.

- [ ] **Step 2: Remove env var pass-through from agent-manager**

In `src/agent-manager.ts`, remove the lines that pass `AGENT_POLL_INTERVAL_SECONDS` and `AGENT_POLL_STATUSES`.

- [ ] **Step 3: Remove poll config from agent-runner**

In `container/agent-runner/src/index.ts`, remove:
```typescript
const AGENT_POLL_INTERVAL_SECONDS = ...;
const AGENT_POLL_STATUSES = ...;
const API_URL = ...;
```

Also remove the `better-sqlite3` import (added earlier, will be used in deterministic-runner instead).

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`
Run: `cd container/agent-runner && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/agent-registry.ts src/agent-manager.ts container/agent-runner/src/index.ts
git commit -m "refactor: remove per-agent polling code, scrum-master handles polling (GH-103)"
```

### Task 10: Run tests

- [ ] **Step 1: Run existing test suite**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
npm test 2>&1 | tail -30
```

Fix any failures caused by status refactor.

- [ ] **Step 2: Commit fixes if any**

```bash
git add -u
git commit -m "fix: update tests for 5-status model (GH-103)"
```

---

## Phase 2: Deterministic runner

### Task 11: Create deterministic-runner project

**Files:**
- Create: `container/deterministic-runner/package.json`
- Create: `container/deterministic-runner/tsconfig.json`
- Create: `container/deterministic-runner/Dockerfile`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "nano-deterministic-runner",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "nats": "^2.19.0",
    "better-sqlite3": "^11.0.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create Dockerfile**

```dockerfile
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++
COPY --from=builder /app/dist/ ./dist/

USER node
CMD ["node", "dist/index.js"]
```

- [ ] **Step 4: Commit**

```bash
git add container/deterministic-runner/
git commit -m "feat: scaffold deterministic-runner container (GH-103)"
```

### Task 12: Implement deterministic runner core

**Files:**
- Create: `container/deterministic-runner/src/types.ts`
- Create: `container/deterministic-runner/src/index.ts`

- [ ] **Step 1: Create types.ts**

```typescript
import type { NatsConnection } from 'nats';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface HandlerContext {
  agentId: string;
  nc: NatsConnection;
  mcp: Client;              // MCP SDK client (handles SSE transport)
  db: Database.Database;    // Read-only connection
  log: Logger;
}

export type Handler = (payload: unknown, ctx: HandlerContext) => Promise<void>;
```

- [ ] **Step 2: Create index.ts**

```typescript
/**
 * Deterministic Runner — executes TypeScript handlers without LLM.
 *
 * Env vars:
 *   NATS_URL    — NATS server URL
 *   AGENT_ID    — unique agent id
 *   CONSUMER_NAME — JetStream consumer name
 *   MCP_GATEWAY_URL — MCP Gateway HTTP endpoint
 *   HANDLER     — handler module name (e.g., "scrum-master")
 *   DB_PATH     — SQLite DB path (read-only)
 *   LOG_LEVEL   — pino log level (default: info)
 */

import { connect, StringCodec } from 'nats';
import type { Consumer } from 'nats';
import Database from 'better-sqlite3';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Handler, HandlerContext } from './types.js';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const AGENT_ID = process.env.AGENT_ID ?? 'unknown';
const CONSUMER_NAME = process.env.CONSUMER_NAME ?? AGENT_ID;
const HANDLER_NAME = process.env.HANDLER;
const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? '';
const DB_PATH = process.env.DB_PATH ?? '/workspace/db/nano-agent-team.db';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const HEARTBEAT_INTERVAL_MS = 15_000;

if (!HANDLER_NAME) {
  console.error('HANDLER env var is required');
  process.exit(1);
}

const log = pino(
  { level: LOG_LEVEL },
  pino.transport({ target: 'pino-pretty', options: { colorize: false, destination: 2 } }),
);

async function main(): Promise<void> {
  // Import handler module
  let handler: Handler;
  try {
    const mod = await import(`./handlers/${HANDLER_NAME}.js`);
    handler = mod.default ?? mod.handle;
    if (typeof handler !== 'function') throw new Error('Handler must export a function');
  } catch (err) {
    log.fatal({ err, handler: HANDLER_NAME }, 'Failed to load handler');
    process.exit(1);
  }

  // Open DB read-only
  const db = new Database(DB_PATH, { readonly: true });

  // Connect to NATS
  const nc = await connect({ servers: NATS_URL, name: `deterministic-${AGENT_ID}` });
  const codec = StringCodec();
  log.info({ agentId: AGENT_ID, handler: HANDLER_NAME, natsUrl: NATS_URL }, 'Deterministic runner starting');

  // Heartbeat
  let isBusy = false;
  const heartbeatTimer = setInterval(() => {
    try {
      nc.publish(`health.${AGENT_ID}`, codec.encode(JSON.stringify({
        agentId: AGENT_ID, ts: Date.now(), busy: isBusy,
      })));
    } catch {
      clearInterval(heartbeatTimer);
      process.exit(0);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // JetStream consumer
  const js = nc.jetstream();
  let consumer: Consumer;
  try {
    consumer = await js.consumers.get('AGENTS', CONSUMER_NAME);
  } catch (err) {
    log.fatal({ err, consumerName: CONSUMER_NAME }, 'Failed to get JetStream consumer');
    clearInterval(heartbeatTimer);
    await nc.drain();
    process.exit(1);
  }

  // Ready signal
  nc.publish(`agent.${AGENT_ID}.ready`, codec.encode(JSON.stringify({ agentId: AGENT_ID, ts: Date.now() })));
  log.info({ agentId: AGENT_ID }, 'Deterministic runner ready');

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down deterministic runner');
    clearInterval(heartbeatTimer);
    db.close();
    nc.drain().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Connect MCP client (handles SSE transport used by MCP Gateway)
  const mcpClient = new Client({ name: `deterministic-${AGENT_ID}`, version: '1.0.0' });
  const mcpTransport = new StreamableHTTPClientTransport(
    new URL(MCP_GATEWAY_URL),
    { requestInit: { headers: { 'x-agent-id': AGENT_ID } } },
  );
  await mcpClient.connect(mcpTransport);
  log.info({ mcpGatewayUrl: MCP_GATEWAY_URL }, 'MCP client connected');

  // Build handler context
  const ctx: HandlerContext = { agentId: AGENT_ID, nc, mcp: mcpClient, db, log };

  // Message processing loop
  for await (const msg of await consumer.consume()) {
    let payload: unknown;
    try {
      payload = JSON.parse(codec.decode(msg.data));
    } catch {
      log.warn({ subject: msg.subject }, 'Non-JSON message — skipping');
      msg.ack();
      continue;
    }

    isBusy = true;
    const workingTimer = setInterval(() => {
      try { msg.working(); } catch { /* ignore */ }
    }, 30_000);

    try {
      await handler(payload, ctx);
    } catch (err) {
      log.error({ err, agentId: AGENT_ID, handler: HANDLER_NAME }, 'Handler error');
    } finally {
      clearInterval(workingTimer);
    }

    isBusy = false;
    msg.ack();
  }
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal deterministic runner error');
  process.exit(1);
});
```

- [ ] **Step 3: Verify compilation**

```bash
cd container/deterministic-runner && npm install && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: Commit**

```bash
git add container/deterministic-runner/src/
git commit -m "feat: implement deterministic runner core (GH-103)"
```

### Task 13: Add handler field to AgentManifest + agent-manager support

**Files:**
- Modify: `src/agent-registry.ts`
- Modify: `src/agent-manager.ts:592-822`

- [ ] **Step 1: Add handler to AgentManifest**

In `src/agent-registry.ts`, add after `allowedTools`:
```typescript
/** Handler module name for deterministic agents. Required when kind === 'deterministic'. */
handler?: string;
```

- [ ] **Step 2: Update buildAgentEnvAndBinds for deterministic agents**

In `src/agent-manager.ts`, in `buildAgentEnvAndBinds()`, add logic to skip LLM env vars and add HANDLER when `kind === 'deterministic'`:

Before the env array construction (around line 669), add a check:
```typescript
const isDeterministic = agent.manifest.kind === 'deterministic';
```

Then conditionally exclude LLM-specific env vars (provider tokens, MODEL, SESSION_TYPE, AGENT_SYSTEM_PROMPT, AGENT_ALLOWED_TOOLS) when `isDeterministic` is true.

Add HANDLER env var:
```typescript
...(isDeterministic && agent.manifest.handler ? [`HANDLER=${agent.manifest.handler}`] : []),
```

- [ ] **Step 3: Update image selection**

The image is already selected via `manifest.image` (line 818). No change needed — the scrum-master manifest will set `"image": "nano-deterministic:latest"`.

- [ ] **Step 4: Add bootstrap alarm for deterministic agents**

In `startAgent()` (around line 269), after starting the container, add:
```typescript
// Bootstrap alarm for deterministic agents with poll behavior
if (agent.manifest.kind === 'deterministic' && this.alarmClock) {
  this.alarmClock.cancelForAgent(id);
  this.alarmClock.set(id, 10, { type: 'poll' }); // First poll after 10s
  logger.info({ agentId: id }, 'Bootstrap alarm set for deterministic agent');
}
```

`alarmClock` is NOT currently in AgentManager. Add it:
1. Add `private alarmClock?: AlarmClock` property to `AgentManager` class
2. Add `alarmClock?: AlarmClock` to constructor params and assign it
3. In `src/index.ts`, pass `alarmClock` when constructing `AgentManager` (AlarmClock is created at line 184 in index.ts)

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 6: Commit**

```bash
git add src/agent-registry.ts src/agent-manager.ts
git commit -m "feat: agent-manager support for deterministic agents (GH-103)"
```

### Task 14: Add deterministic-runner to build pipeline

**Files:**
- Modify: `docker-compose.yml`
- Modify: `install.sh`

- [ ] **Step 1: Build deterministic-runner image in install.sh**

Add before the main `docker compose up` command:
```bash
echo "Building deterministic-runner image..."
docker build -t nano-deterministic:latest container/deterministic-runner/ 2>&1 | tail -5
```

- [ ] **Step 2: Add deterministic-runner build to docker-compose**

This is optional — the image is built standalone and referenced by manifest. No compose service needed (the scrum-master runs as a regular agent container managed by agent-manager).

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: add deterministic-runner to build pipeline (GH-103)"
```

---

## Phase 3: Scrum-master agent

### Task 15: Implement scrum-master handler

**Files:**
- Create: `container/deterministic-runner/src/handlers/scrum-master.ts`

- [ ] **Step 1: Create the handler**

```typescript
/**
 * Scrum-Master Handler — polls tickets, claims work, dispatches agents, detects orphans.
 *
 * On each wakeup:
 * 1. Find waiting tickets → claim (expected_status) → dispatch via NATS
 * 2. Find in_progress tickets → check heartbeats → revert orphans
 * 3. Set next alarm (adaptive interval)
 */

import { StringCodec } from 'nats';
import type { Handler, HandlerContext } from '../types.js';

const codec = StringCodec();
const MAX_ORPHAN_RECOVERIES = 3;
const GRACE_PERIOD_MS = 30_000; // 2× heartbeat interval

interface TicketRow {
  id: string;
  title: string;
  status: string;
  assigned_to: string | null;
  updated_at: string;
}

interface AgentState {
  agentId: string;
  busy?: boolean;
  ticketId?: string;
  status: string;
}

/** Call an MCP tool via the SDK client (handles SSE transport correctly) */
async function mcpCall(
  ctx: HandlerContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await ctx.mcp.callTool({ name: tool, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
  if (result.isError) throw new Error(text ?? 'MCP tool error');
  return text ? JSON.parse(text) : null;
}

const handle: Handler = async (payload, ctx) => {
  const { agentId, nc, db, log } = ctx;

  log.info({ agentId }, 'Scrum-master wakeup — polling tickets');

  let workFound = 0;

  // ── 1. Dispatch waiting tickets ─────────────────────────────────────────
  const waitingTickets = db.prepare(
    'SELECT id, title, status, assigned_to, updated_at FROM tickets WHERE status = ?'
  ).all('waiting') as TicketRow[];

  for (const ticket of waitingTickets) {
    if (!ticket.assigned_to) {
      log.warn({ ticketId: ticket.id }, 'Waiting ticket has no assigned_to — skipping');
      continue;
    }

    // Claim via MCP (expected_status for optimistic lock)
    try {
      await mcpCall(ctx, 'ticket_update', {
        ticket_id: ticket.id,
        status: 'in_progress',
        expected_status: 'waiting',
      });
    } catch (err) {
      log.info({ ticketId: ticket.id, err }, 'Failed to claim ticket (likely already claimed)');
      continue;
    }

    // Dispatch: publish NATS message to agent's task entrypoint
    const dispatchPayload = { ticket_id: ticket.id, title: ticket.title };
    const subject = `agent.${ticket.assigned_to}.task`;
    try {
      const js = nc.jetstream();
      await js.publish(subject, codec.encode(JSON.stringify(dispatchPayload)));
      log.info({ ticketId: ticket.id, agent: ticket.assigned_to, subject }, 'Dispatched ticket');
      workFound++;
    } catch (err) {
      log.error({ err, ticketId: ticket.id, subject }, 'Failed to dispatch — reverting claim');
      // Revert claim on dispatch failure
      try {
        await mcpCall(ctx, 'ticket_update', {
          ticket_id: ticket.id,
          status: 'waiting',
          expected_status: 'in_progress',
        });
      } catch { /* best effort */ }
    }
  }

  // ── 2. Orphan detection ─────────────────────────────────────────────────
  const inProgressTickets = db.prepare(
    'SELECT id, title, status, assigned_to, updated_at FROM tickets WHERE status = ?'
  ).all('in_progress') as TicketRow[];

  // Get running agent states for heartbeat matching
  let agentStates: AgentState[] = [];
  try {
    const status = await mcpCall(ctx, 'get_system_status', {}) as {
      agents?: AgentState[];
    };
    agentStates = status?.agents ?? [];
  } catch (err) {
    log.warn({ err }, 'Failed to get system status — skipping orphan detection');
  }

  for (const ticket of inProgressTickets) {
    // Grace period: skip recently updated tickets
    const updatedAt = new Date(ticket.updated_at.replace(' ', 'T') + 'Z').getTime();
    if (Date.now() - updatedAt < GRACE_PERIOD_MS) continue;

    // Check if any agent instance is working on this ticket
    const workingAgent = agentStates.find(
      (a) => a.ticketId === ticket.id && a.status === 'running'
    );

    if (workingAgent) continue; // Agent is alive and working

    // Orphan detected — check recovery count via comments
    log.warn({ ticketId: ticket.id, assignedTo: ticket.assigned_to }, 'Orphan detected');

    // Count previous recoveries (search comments for pattern)
    let recoveryCount = 0;
    try {
      const comments = db.prepare(
        "SELECT body FROM ticket_comments WHERE ticket_id = ? AND body LIKE 'Orphan recovery%'"
      ).all(ticket.id) as Array<{ body: string }>;
      recoveryCount = comments.length;
    } catch { /* ignore */ }

    if (recoveryCount >= MAX_ORPHAN_RECOVERIES) {
      // Too many recoveries — reject the ticket
      log.error({ ticketId: ticket.id, recoveryCount }, 'Max orphan recoveries exceeded — rejecting');
      try {
        await mcpCall(ctx, 'ticket_update', {
          ticket_id: ticket.id,
          status: 'rejected',
          expected_status: 'in_progress',
        });
        await mcpCall(ctx, 'ticket_comment', {
          ticket_id: ticket.id,
          body: `Rejected: ticket orphaned ${recoveryCount + 1} times. Agent ${ticket.assigned_to} repeatedly fails to complete this ticket.`,
        });
      } catch { /* best effort */ }
      continue;
    }

    // Revert to waiting for retry
    try {
      await mcpCall(ctx, 'ticket_update', {
        ticket_id: ticket.id,
        status: 'waiting',
        expected_status: 'in_progress',
      });
      await mcpCall(ctx, 'ticket_comment', {
        ticket_id: ticket.id,
        body: `Orphan recovery #${recoveryCount + 1}: agent ${ticket.assigned_to} not responding. Ticket returned to waiting.`,
      });
      log.info({ ticketId: ticket.id, recovery: recoveryCount + 1 }, 'Orphan reverted to waiting');
    } catch (err) {
      log.error({ err, ticketId: ticket.id }, 'Failed to revert orphan');
    }
  }

  // ── 3. Set next alarm ──────────────────────────────────────────────────
  const totalWaiting = waitingTickets.length;
  let interval: number;
  if (totalWaiting > 5) interval = 15;
  else if (workFound > 0) interval = 30;
  else interval = 300;

  try {
    await mcpCall(ctx, 'alarm_set', {
      delay_seconds: interval,
      payload: { type: 'poll' },
    });
    log.info({ interval, workFound, waitingCount: totalWaiting }, 'Next alarm set');
  } catch (err) {
    log.error({ err }, 'Failed to set next alarm — scrum-master will stop polling!');
  }
};

export default handle;
```

- [ ] **Step 2: Verify compilation**

```bash
cd container/deterministic-runner && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add container/deterministic-runner/src/handlers/
git commit -m "feat: implement scrum-master handler (GH-103)"
```

### Task 16: Create scrum-master manifest + workflow update

**Files:**
- Create: `hub/agents/sd-scrum-master/manifest.json`
- Modify: `hub/teams/self-dev-team/workflow.json`

- [ ] **Step 1: Create manifest**

```json
{
  "id": "sd-scrum-master",
  "name": "Self-Dev Scrum Master",
  "version": "0.1.0",
  "description": "Deterministic pipeline orchestrator. Polls tickets, claims work, dispatches agents, detects orphans.",
  "kind": "deterministic",
  "handler": "scrum-master",
  "image": "nano-deterministic:latest",
  "session_type": "persistent",
  "entrypoints": ["inbox", "task"],
  "mcp_permissions": {
    "tickets": ["list", "get", "update", "comment"],
    "management": ["alarm_set", "alarm_cancel", "alarm_list", "get_system_status"]
  }
}
```

- [ ] **Step 2: Update workflow.json**

Add sd-scrum-master to the agents list and bindings:
```json
{
  "agents": ["sd-pm", "sd-scrum-master", "sd-architect", ...],
  "bindings": {
    "sd-scrum-master": {
      "inputs": {}
    },
    ...
  }
}
```

Scrum-master has no topic bindings — it's alarm-driven only.

- [ ] **Step 3: Commit**

```bash
git add hub/agents/sd-scrum-master/ hub/teams/self-dev-team/workflow.json
git commit -m "feat: add sd-scrum-master agent and workflow binding (GH-103)"
```

---

## Phase 4: sd-* agent updates

### Task 17: Update sd-* CLAUDE.md for new status model

**Files:**
- Modify: `hub/agents/sd-pm/CLAUDE.md`
- Modify: `hub/agents/sd-architect/CLAUDE.md`
- Modify: `hub/agents/sd-developer/CLAUDE.md`
- Modify: `hub/agents/sd-reviewer/CLAUDE.md`
- Modify: `hub/agents/sd-committer/CLAUDE.md`
- Modify: `hub/agents/sd-release-manager/CLAUDE.md`

- [ ] **Step 1: Read all sd-* CLAUDE.md files**

Read each file to understand current instructions.

- [ ] **Step 2: Update each agent's workflow section**

For each agent, update the ticket status transitions in their CLAUDE.md:

**sd-pm:** After approval: `ticket_update(status: waiting, assigned_to: sd-architect)`

**sd-architect:** After spec complete: `ticket_update(status: waiting, assigned_to: sd-developer)`

**sd-developer:** After implementation: `ticket_update(status: waiting, assigned_to: sd-reviewer)`

**sd-reviewer:** After review pass: `ticket_update(status: waiting, assigned_to: sd-committer)`. After review fail: `ticket_update(status: waiting, assigned_to: sd-developer)` (retry)

**sd-committer:** After commit: `ticket_update(status: waiting, assigned_to: sd-release-manager)`

**sd-release-manager:** After release: `ticket_update(status: done)`

Key changes in each file:
- Replace old status values with `waiting`/`in_progress`
- Add `assigned_to: next_agent` to the completion step
- Remove `nats pub` CLI commands for signaling (scrum-master handles dispatch)
- Keep NATS pub for non-pipeline signals if still needed (e.g., `topic.deploy.done` for ops)

- [ ] **Step 3: Commit**

```bash
git add hub/agents/sd-*/CLAUDE.md
git commit -m "feat: update sd-* agent instructions for waiting/in_progress model (GH-103)"
```

---

## Phase 5: Cleanup + validation

### Task 18: Build and verify

- [ ] **Step 1: Build deterministic-runner image**

```bash
cd container/deterministic-runner && npm run build
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
docker build -t nano-deterministic:latest container/deterministic-runner/
```

- [ ] **Step 2: Build main project**

```bash
npx tsc --noEmit
npm test 2>&1 | tail -30
```

- [ ] **Step 3: Verify agent-runner builds**

```bash
cd container/agent-runner && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -u
git commit -m "fix: build fixes for pull-over-push (GH-103)"
```

### Task 19: Integration test

- [ ] **Step 1: Start the stack**

```bash
cd /Users/rpridal/workspace/nano-agent-team-project/nano-agent-team
docker compose -f docker-compose.dev.yml up --build -d
```

- [ ] **Step 2: Create a test ticket and verify scrum-master dispatches it**

```bash
# Create ticket via API
curl -X POST http://localhost:3002/api/tickets \
  -H 'Content-Type: application/json' \
  -d '{"title": "Test pull-over-push", "status": "waiting", "assigned_to": "sd-architect"}'

# Wait for scrum-master alarm (10s bootstrap + processing time)
sleep 15

# Check ticket status — should be in_progress
curl http://localhost:3002/api/tickets/TICK-XXXX | jq .status
```

- [ ] **Step 3: Verify orphan detection**

Kill the agent container manually, wait for next scrum-master wakeup, verify ticket reverts to `waiting`.

- [ ] **Step 4: Document results and commit**

```bash
git add -u
git commit -m "test: verify pull-over-push pipeline end-to-end (GH-103)"
```
