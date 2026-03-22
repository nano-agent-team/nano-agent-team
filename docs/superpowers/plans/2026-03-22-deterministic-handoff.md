# Deterministic Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents do work + optional verdict comment. Agent-runner sets `done`. Scrum-master owns all routing.

**Architecture:** Add `verdict` column to ticket_comments. Agent-runner after-work hook sets `status: done` for ephemeral agents. Scrum-master reads verdict from last comment + routes via `pipeline` config in workflow.json.

**Tech Stack:** TypeScript, SQLite, MCP Zod schemas

**Spec:** `docs/superpowers/specs/2026-03-22-deterministic-handoff-design.md`

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/db.ts` | Modify | Add `verdict` column to ticket_comments |
| `src/tickets/types.ts` | Modify | Add `verdict` to TicketComment type |
| `src/tickets/local-provider.ts` | Modify | Store/return verdict in addComment |
| `src/mcp-gateway.ts` | Modify | Add `verdict` to ticket_comment Zod schema |
| `container/agent-runner/src/tickets-mcp-stdio.ts` | Modify | Add `verdict` to ticket_comment Zod schema |
| `container/agent-runner/src/index.ts` | Modify | After-work hook: set done after ephemeral LLM success |
| `container/deterministic-runner/src/handlers/scrum-master.ts` | Modify | Route `done` tickets via verdict + pipeline config |
| `hub/teams/self-dev-team/workflow.json` | Modify | Add `pipeline` section |
| `hub/agents/sd-*/CLAUDE.md` | Modify | Remove handoff instructions, add verdict for reviewer |

---

### Task 1: Add verdict to ticket_comments schema + types

**Files:**
- Modify: `src/db.ts`
- Modify: `src/tickets/types.ts`
- Modify: `src/tickets/local-provider.ts`

- [ ] **Step 1: Add verdict column to DB schema**

In `src/db.ts`, find the `CREATE TABLE IF NOT EXISTS ticket_comments` statement. Add `verdict TEXT` column.

Also add a migration: if table exists but verdict column doesn't, `ALTER TABLE ticket_comments ADD COLUMN verdict TEXT`.

- [ ] **Step 2: Add verdict to TicketComment type**

In `src/tickets/types.ts`, find `TicketComment` interface and add:
```typescript
verdict?: 'approved' | 'rejected' | 'rework';
```

- [ ] **Step 3: Update local-provider addComment**

In `src/tickets/local-provider.ts`, find `addComment` method. Add `verdict` parameter to the INSERT and return it in the result.

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/tickets/types.ts src/tickets/local-provider.ts
git commit -m "feat: add verdict field to ticket comments schema"
```

---

### Task 2: Add verdict to MCP tool Zod schemas

**Files:**
- Modify: `src/mcp-gateway.ts`
- Modify: `container/agent-runner/src/tickets-mcp-stdio.ts`

- [ ] **Step 1: Update mcp-gateway ticket_comment tool**

Find `ticket_comment` tool registration. Add to Zod schema:
```typescript
verdict: z.enum(['approved', 'rejected', 'rework']).optional().describe('Optional verdict: approved (proceed), rework (send back), rejected (stop pipeline)'),
```

Pass `verdict` to `registry.addComment()` call.

- [ ] **Step 2: Update tickets-mcp-stdio ticket_comment tool**

Same change in `container/agent-runner/src/tickets-mcp-stdio.ts`. Add `verdict` to Zod schema and pass it in the HTTP POST body or direct DB insert.

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -10
cd container/agent-runner && npx tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 4: Commit**

```bash
git add src/mcp-gateway.ts container/agent-runner/src/tickets-mcp-stdio.ts
git commit -m "feat: add verdict parameter to ticket_comment MCP tool"
```

---

### Task 3: Agent-runner after-work hook

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Add after-work hook in ephemeral mode**

Find the ephemeral mode section (search for `EPHEMERAL_TASK_MESSAGE`). After the provider.run() loop completes, before `process.exit()`, add:

```typescript
// After-work hook: set ticket to done (deterministic handoff)
const ephemeralTicketId = process.env.EPHEMERAL_TICKET_ID;
if (!errorSubtype && ephemeralTicketId) {
  try {
    const apiUrl = MCP_GATEWAY_URL.replace('/mcp', '') || 'http://host.docker.internal:3001';
    const resp = await fetch(`${apiUrl}/api/tickets/${encodeURIComponent(ephemeralTicketId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done', expected_status: 'in_progress', changed_by: AGENT_ID }),
    });
    if (resp.ok) {
      log.info({ ticketId: ephemeralTicketId }, 'After-work: ticket set to done');
    } else {
      log.warn({ ticketId: ephemeralTicketId, status: resp.status }, 'After-work: failed to set done');
    }
  } catch (err) {
    log.warn({ err, ticketId: ephemeralTicketId }, 'After-work: error setting done (non-fatal)');
  }
}
```

Key: uses `expected_status: in_progress` for safety. Only fires for ephemeral agents (`EPHEMERAL_TICKET_ID` env var). Non-fatal on failure.

- [ ] **Step 2: Verify compilation**

```bash
cd container/agent-runner && npx tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 3: Rebuild agent image**

```bash
cd container/agent-runner && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: agent-runner after-work hook sets done for ephemeral agents"
```

---

### Task 4: Scrum-master routing for done tickets

**Files:**
- Modify: `container/deterministic-runner/src/handlers/scrum-master.ts`

- [ ] **Step 1: Add pipeline config reading**

At the top of the handler, read pipeline config. The scrum-master gets workflow.json data from a new env var `PIPELINE_CONFIG` (JSON string) or reads it from the DB/filesystem. Simplest: hardcode the pipeline map for now, extract to config later.

```typescript
const PIPELINE: Record<string, { next: string | null; retry?: string }> = {
  'sd-pm':              { next: 'sd-architect' },
  'sd-architect':       { next: 'sd-developer' },
  'sd-developer':       { next: 'sd-reviewer' },
  'sd-reviewer':        { next: 'sd-committer', retry: 'sd-developer' },
  'sd-committer':       { next: 'sd-release-manager' },
  'sd-release-manager': { next: null },
};
```

- [ ] **Step 2: Add done ticket routing**

After the existing dispatch (section 1) and orphan detection (section 2), add a new section 3 (before alarm scheduling):

```typescript
// ── 3. Route done tickets ──────────────────────────────────────
let doneTickets: TicketRow[] = [];
try {
  const rawDone = await callMcpTool(mcp, 'tickets_list', { status: 'done' }) as TicketRow[];
  doneTickets = Array.isArray(rawDone) ? rawDone : [];
} catch (err) {
  log.error({ err }, 'Failed to list done tickets');
}

for (const ticket of doneTickets) {
  const completedBy = getAssignee(ticket);
  if (!completedBy) continue;

  const route = PIPELINE[completedBy];
  if (!route) continue; // Unknown agent, skip

  // Read last comment verdict
  let verdict: string | undefined;
  try {
    const comments = await callMcpTool(mcp, 'ticket_get', { ticket_id: ticket.id }) as { comments?: Array<{ verdict?: string }> };
    const lastComment = comments?.comments?.slice(-1)[0];
    verdict = lastComment?.verdict;
  } catch { /* ignore */ }

  let nextAgent: string | null;
  if (verdict === 'rejected') {
    // Pipeline stop
    try {
      await callMcpTool(mcp, 'ticket_update', { ticket_id: ticket.id, status: 'rejected' });
      log.info({ ticketId: ticket.id, verdict }, 'Ticket rejected by pipeline');
    } catch { /* ignore */ }
    continue;
  } else if (verdict === 'rework' && route.retry) {
    nextAgent = route.retry;
  } else {
    nextAgent = route.next;
  }

  if (!nextAgent) {
    // Pipeline complete — ticket stays done
    log.info({ ticketId: ticket.id, completedBy }, 'Pipeline complete');
    continue;
  }

  // Route to next agent
  try {
    await callMcpTool(mcp, 'ticket_update', {
      ticket_id: ticket.id,
      status: 'waiting',
      assignee: nextAgent,
      expected_status: 'done',
    });
    log.info({ ticketId: ticket.id, from: completedBy, to: nextAgent, verdict: verdict ?? 'default' }, 'Routed done ticket');
    workFound = true;
  } catch (err) {
    log.warn({ ticketId: ticket.id, err }, 'Failed to route done ticket');
  }
}
```

- [ ] **Step 3: Verify compilation + rebuild**

```bash
cd container/deterministic-runner && npm run build 2>&1 | tail -3
docker build -t nano-deterministic:latest . 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add container/deterministic-runner/src/handlers/scrum-master.ts
git commit -m "feat: scrum-master routes done tickets via verdict + pipeline config"
```

---

### Task 5: Workflow.json pipeline config

**Files:**
- Modify: `hub/teams/self-dev-team/workflow.json`

- [ ] **Step 1: Add pipeline section**

Add `pipeline` object to workflow.json:
```json
{
  "pipeline": {
    "sd-pm":              { "next": "sd-architect" },
    "sd-architect":       { "next": "sd-developer" },
    "sd-developer":       { "next": "sd-reviewer" },
    "sd-reviewer":        { "next": "sd-committer", "retry": "sd-developer" },
    "sd-committer":       { "next": "sd-release-manager" },
    "sd-release-manager": { "next": null }
  }
}
```

Note: For now the scrum-master handler has this hardcoded. Future: read from workflow.json via config.

- [ ] **Step 2: Commit**

```bash
cd /path/to/hub
git add teams/self-dev-team/workflow.json
git commit -m "feat: add pipeline routing config to workflow.json"
```

---

### Task 6: Update sd-* CLAUDE.md

**Files:**
- Modify: `hub/agents/sd-architect/CLAUDE.md`
- Modify: `hub/agents/sd-developer/CLAUDE.md`
- Modify: `hub/agents/sd-reviewer/CLAUDE.md`
- Modify: `hub/agents/sd-committer/CLAUDE.md`
- Modify: `hub/agents/sd-release-manager/CLAUDE.md`

- [ ] **Step 1: Remove handoff instructions from all agents**

For each agent, remove any `ticket_update` calls that set `status: waiting` or `assignee: next_agent`. The agent should NOT know about the next pipeline step.

Remove lines like:
```
mcp__tickets__ticket_update({ ticket_id, status: "waiting", assignee: "sd-developer" })
```

Keep `ticket_comment` calls — agents should still document their work.

- [ ] **Step 2: Add verdict to sd-reviewer**

In sd-reviewer CLAUDE.md, update Step 5a (pass) and Step 5b (rework):

```markdown
### Step 5a — Pass
mcp__tickets__ticket_comment({ ticket_id, body: "## Review: APPROVED\n...", verdict: "approved" })

### Step 5b — Rework
mcp__tickets__ticket_comment({ ticket_id, body: "## Review: CHANGES REQUESTED\n...", verdict: "rework" })
```

Remove `ticket_update` from reviewer — status is set by agent-runner, routing by scrum-master.

- [ ] **Step 3: Remove ticket_update from reviewer MCP tools table**

Since reviewer no longer calls ticket_update, remove it from the tools table (or keep as "do not use").

- [ ] **Step 4: Commit**

```bash
git add agents/sd-*/CLAUDE.md
git commit -m "feat: remove handoff instructions, add verdict for reviewer"
```

---

### Task 7: Build, deploy, test

- [ ] **Step 1: Build all**

```bash
npx tsc
cd container/agent-runner && npm run build
cd container/deterministic-runner && npm run build && docker build -t nano-deterministic:latest .
```

- [ ] **Step 2: Push + deploy**

```bash
git push origin main
docker compose -f docker-compose.dev.yml down && docker compose -f docker-compose.dev.yml up --build -d
# Install team
```

- [ ] **Step 3: E2E test**

Create a ticket with `pipeline-ready` label. Kick sd-pm. Verify:
- sd-pm approves
- sd-architect writes spec, agent-runner sets done
- scrum-master routes to sd-developer
- sd-developer implements, agent-runner sets done
- scrum-master routes to sd-reviewer
- sd-reviewer approves (verdict: approved), agent-runner sets done
- scrum-master routes to sd-committer
- Full pipeline without LLM handoff
