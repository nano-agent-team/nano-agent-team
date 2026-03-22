# Deterministic Handoff: Agent-Runner After-Work Hook + Verdict Comments

## Summary

Pipeline agents should not know about subsequent workflow steps. Each agent does its work, optionally reports a verdict, and the agent-runner deterministically sets `status: done`. The scrum-master — the ONLY agent aware of the full workflow — routes tickets to the next (or retry) agent based on the verdict and workflow.json.

## Architecture Principle

**Workflow routing is owned by exactly one agent: the scrum-master.** Individual pipeline agents (architect, developer, reviewer, committer) have zero knowledge of what comes next in the pipeline. They:
1. Receive a ticket
2. Do their domain work
3. Optionally report a verdict via `ticket_comment({ verdict: "approved" })`
4. Exit — agent-runner sets `status: done` deterministically

This separation ensures:
- Adding/removing/reordering pipeline stages requires changes ONLY in workflow.json + scrum-master
- Agents are reusable across different workflows without CLAUDE.md changes
- No LLM is involved in routing decisions — routing is deterministic

## Verdict on Comments

```typescript
interface TicketComment {
  id: number;
  ticket_id: string;
  author: string;
  body: string;
  verdict?: 'approved' | 'rejected' | 'rework';  // NEW: optional
  created_at: string;
}
```

- `approved` — agent completed successfully, proceed to next stage (default if no verdict)
- `rework` — agent found issues, send back to retry agent (e.g., reviewer → developer)
- `rejected` — ticket should not proceed, pipeline stops

Most agents never set a verdict — their work is always "done, move on." Only agents with branching output (reviewer, pm) use verdicts.

## Agent-Runner After-Work Hook

In `container/agent-runner/src/index.ts`, after successful LLM completion in ephemeral mode:

```typescript
// After provider.run() completes successfully (no errorSubtype):
if (!errorSubtype && ticketId) {
  try {
    const apiUrl = process.env.MCP_GATEWAY_URL?.replace('/mcp', '') ?? 'http://host.docker.internal:3001';
    await fetch(`${apiUrl}/api/tickets/${encodeURIComponent(ticketId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done', expected_status: 'in_progress', changed_by: AGENT_ID }),
    });
    log.info({ ticketId, agentId: AGENT_ID }, 'After-work: ticket set to done');
  } catch (err) {
    log.warn({ err, ticketId }, 'After-work: failed to set ticket done (non-fatal)');
  }
}
```

This runs ONLY for ephemeral agents (`EPHEMERAL_TASK_MESSAGE` is set). Persistent agents don't auto-close tickets.

Uses `expected_status: in_progress` to avoid race conditions — only transitions if ticket is still in_progress.

## Scrum-Master Routing

When scrum-master finds a `done` ticket, it reads the last comment's `verdict` field and routes:

```
done ticket (assignee = sd-reviewer)
  → last comment verdict = "approved" → next from workflow = sd-committer → waiting (sd-committer)
  → last comment verdict = "rework"   → retry from workflow = sd-developer → waiting (sd-developer)
  → last comment verdict = "rejected" → status: rejected, pipeline stops
  → no verdict (default)              → next from workflow = sd-committer → waiting (sd-committer)
```

### Workflow.json Extension

```json
{
  "pipeline": {
    "sd-architect":       { "next": "sd-developer" },
    "sd-developer":       { "next": "sd-reviewer" },
    "sd-reviewer":        { "next": "sd-committer", "retry": "sd-developer" },
    "sd-committer":       { "next": "sd-release-manager" },
    "sd-release-manager": { "next": null }
  }
}
```

`next: null` = pipeline complete, ticket stays `done`.

## Changes Required

| Component | Change |
|-----------|--------|
| `src/db.ts` | Add `verdict` column to `ticket_comments` table |
| `src/tickets/types.ts` | Add `verdict?: string` to `TicketComment` type |
| `src/tickets/local-provider.ts` | Store/return verdict in comment CRUD |
| `src/mcp-gateway.ts` | Add `verdict` to `ticket_comment` Zod schema |
| `container/agent-runner/src/tickets-mcp-stdio.ts` | Add `verdict` to `ticket_comment` Zod schema |
| `container/agent-runner/src/index.ts` | After-work hook: set `done` after successful ephemeral LLM run |
| `container/deterministic-runner/src/handlers/scrum-master.ts` | Route `done` tickets: read verdict, apply workflow.json routing |
| `hub/teams/self-dev-team/workflow.json` | Add `pipeline` section with next/retry mapping |
| `hub/agents/sd-*/CLAUDE.md` | Remove all handoff instructions (assignee, status transitions). Add verdict usage for reviewer. |

## sd-* CLAUDE.md Changes

**Remove from ALL agents:** Any instructions to call `ticket_update` for status/assignee handoff.

**Keep:** `ticket_comment` calls for documenting work.

**Add to sd-reviewer:** Use `verdict` parameter:
```
mcp__tickets__ticket_comment({ ticket_id, body: "## Review: APPROVED\n...", verdict: "approved" })
mcp__tickets__ticket_comment({ ticket_id, body: "## Review: CHANGES REQUESTED\n...", verdict: "rework" })
```

**Add to sd-pm:** Use `verdict` for rejection:
```
mcp__tickets__ticket_comment({ ticket_id, body: "Rejected because...", verdict: "rejected" })
```
