# Foreman Chat UI — Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Problem

The current `simple-chat` feature is a minimal single-session chat with no persistence, no conversation history, and a basic "..." typing indicator. It doesn't communicate what Foreman is actually doing during processing.

**Goal:** A proper chat interface for Foreman — persistent conversation history, sidebar navigation, and a human-readable activity feed written by Foreman himself.

---

## Layout

### Sidebar (left, 180px)

- "New conversation" button at top
- Chronological list of past conversations grouped by date (Today / Yesterday / older dates)
- Each entry: truncated title (first user message, max 80 chars) + timestamp
- Active conversation highlighted

### Main Chat Area (right)

- Header: Foreman avatar + name + online status
- Message list: infinite scroll (older messages loaded on scroll up)
- Input: rounded text input + send button (circular)

---

## Activity Indicator

Foreman writes human-readable progress descriptions himself via a dedicated MCP tool.

### `emit_progress` MCP tool (new, management namespace)

```typescript
emit_progress({ text: string })
```

Foreman calls this tool before each significant action. The management MCP server publishes the text directly to the active `streamSubject` as a `progress` SSE event:

```json
{ "type": "progress", "text": "Looking up GitHub Team in the hub catalog" }
```

This is the only reliable mechanism — Foreman cannot inject arbitrary events into the SSE stream via text tokens. The tool call gives the control plane a well-defined hook to publish to the correct stream.

**Frontend display:** Progress steps shown as an inline feed above the final response bubble. Each step has a status icon:
- ⟳ (in progress — current step)
- ✓ (done — previous steps)
- ✗ (failed — if an `error` SSE event arrives mid-stream, current ⟳ step becomes ✗)

Steps collapse into a summary line once Foreman finishes ("5 kroků").

**Foreman CLAUDE.md instruction:** Before each significant action, call `emit_progress` with a short English description in first person. Examples:
- "Looking up GitHub Team in the hub catalog"
- "Starting sd-developer on ticket TICK-0012"
- "Checking status of all agents"

(Language: English — consistent with agent CLAUDE.md language policy. Progress text is displayed as-is in the UI without translation.)

---

## Persistence

### Backend

New tables in SQLite (`src/db.ts`):

```sql
conversations (
  id TEXT PRIMARY KEY,          -- also used as Foreman sessionId
  agent_id TEXT DEFAULT 'foreman',
  title TEXT NOT NULL,          -- first user message, truncated to 80 chars
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,            -- 'user' | 'agent'
  text TEXT NOT NULL,
  progress_steps TEXT,           -- JSON: [{text: string, status: 'done'|'error'}], agent messages only
  created_at TEXT NOT NULL
)
```

**`conversation_id` = `sessionId`:** The same UUID is used as both the database conversation identifier and the Foreman Claude SDK session ID. Switching conversations in the sidebar switches the Foreman session context.

**`progress_steps` storage:** Steps are written to the database only after the stream completes (`done` event). During streaming, the frontend accumulates steps in memory. On `done`, the frontend sends a PATCH to persist the final steps array. Each element: `{ text: string, status: 'done' | 'error' }`. On history load, the frontend renders saved steps directly without re-streaming.

### API endpoints

```
POST /api/chat/conversations                                     → create conversation (returns id)
GET  /api/chat/conversations                                     → list (id, title, updated_at)
GET  /api/chat/conversations/:id/messages?before=<id>&limit=30  → paginated history (newest-first)
POST /api/chat/conversations/:id/message                        → send message (SSE streaming)
PATCH /api/chat/conversations/:id/messages/:msgId               → update progress_steps after stream done
```

**Plugin NATS access:** `features/foreman-chat/plugin.mjs` receives `nc` (NATS connection) via the standard plugin opts argument (same pattern as `features/observability/plugin.mjs`). The SSE streaming endpoint subscribes to `streamSubject` using `nc` directly.

### Infinite scroll

`IntersectionObserver` on a sentinel element at the top of the message list triggers loading of the next page of older messages. To prevent scroll position jump:
1. Read `messageList.scrollHeight` before prepending
2. Prepend messages to DOM
3. Set `messageList.scrollTop += newScrollHeight - oldScrollHeight`

---

## What Changes

| Component | Change |
|-----------|--------|
| `features/foreman-chat/feature.json` | New — feature manifest (id: `foreman-chat`, provides: `[chat]`, route: `/chat`) |
| `features/foreman-chat/plugin.mjs` | New — conversation CRUD API + SSE streaming (replaces simple-chat plugin) |
| `features/foreman-chat/frontend/src/ForemanChatView.vue` | New — Layout B implementation |
| `features/simple-chat/` | Deprecated — replaced by foreman-chat |
| `src/db.ts` | Add `conversations` + `messages` tables |
| `src/mcp-gateway.ts` | Add `emit_progress` to management MCP tools |
| `data/vault/agents/foreman.md` | Add `emit_progress` usage instructions |
| SSE streaming | Add `progress` event type alongside existing `chunk` / `tool_call` |

---

## Dependencies

- Foreman agent (already exists)
- SQLite db (already exists via `src/db.ts`)
- SSE streaming (already exists)
- Management MCP server (already exists — `emit_progress` added here)

---

## Out of Scope

- Markdown rendering
- File/image attachments
- Multi-agent chat (only Foreman for now)
- Mobile-optimized layout
