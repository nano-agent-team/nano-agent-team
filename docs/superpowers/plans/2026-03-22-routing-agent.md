# Routing Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scrum-master owns all routing via manifest config. Workflow.json reduced to team member list. Agent manifests declare their own subscriptions.

**Architecture:** Move subscribe_topics to each agent manifest. Add `routes` config to scrum-master manifest for NATS event forwarding. Scrum-master handler creates consumers and forwards messages. Remove bindings from workflow.json and control plane binding resolution.

**Tech Stack:** TypeScript, NATS JetStream, JSON manifests

**Spec:** `docs/superpowers/specs/2026-03-22-routing-agent-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `hub/agents/sd-*/manifest.json` | Add `subscribe_topics` |
| `hub/agents/sd-scrum-master/manifest.json` | Add `routes` |
| `hub/teams/self-dev-team/workflow.json` | Remove `bindings` |
| `container/deterministic-runner/src/handlers/scrum-master.ts` | Add NATS forwarding for `routes` |
| `src/index.ts` | Remove workflow binding resolution |

---

### Task 1: Add subscribe_topics to all agent manifests

**Files:**
- Modify: `hub/agents/sd-pm/manifest.json`
- Modify: `hub/agents/sd-architect/manifest.json`
- Modify: `hub/agents/sd-developer/manifest.json`
- Modify: `hub/agents/sd-reviewer/manifest.json`
- Modify: `hub/agents/sd-committer/manifest.json`
- Modify: `hub/agents/sd-release-manager/manifest.json`
- Modify: `hub/agents/sd-ops/manifest.json`
- Modify: `hub/agents/sd-hub-publisher/manifest.json`
- Modify: `hub/agents/foreman/manifest.json`

- [ ] **Step 1: Add subscribe_topics to each agent manifest**

For each agent, add `subscribe_topics` array. Pattern: `["agent.{id}.inbox", "agent.{id}.task"]`. sd-pm additionally gets `"topic.ticket.new"` (needs to react to new tickets).

sd-scrum-master already has subscribe_topics — no change needed.

- [ ] **Step 2: Commit (hub repo)**

```bash
git add agents/*/manifest.json
git commit -m "feat: add subscribe_topics to all agent manifests"
```

---

### Task 2: Add routes to scrum-master manifest + strip workflow.json

**Files:**
- Modify: `hub/agents/sd-scrum-master/manifest.json`
- Modify: `hub/teams/self-dev-team/workflow.json`

- [ ] **Step 1: Add routes and route subscriptions to scrum-master manifest**

Add `routes` to scrum-master manifest:
```json
"routes": {
  "topic.release.ready":  "sd-ops",
  "topic.hub.deploy":     "sd-hub-publisher",
  "topic.deploy.failed":  "foreman",
  "topic.hub.published":  "foreman"
}
```

Also add route source topics to scrum-master's `subscribe_topics` so it receives these messages:
```json
"subscribe_topics": [
  "agent.sd-scrum-master.inbox",
  "agent.sd-scrum-master.task",
  "topic.release.ready",
  "topic.hub.deploy",
  "topic.deploy.failed",
  "topic.hub.published"
]
```

- [ ] **Step 2: Strip workflow.json to agents list only**

Replace entire workflow.json with:
```json
{
  "id": "self-dev-team",
  "name": "Self-Dev Team",
  "version": "0.4.0",
  "description": "Self-development pipeline. Routing owned by sd-scrum-master.",
  "agents": ["sd-pm", "sd-scrum-master", "sd-architect", "sd-developer", "sd-reviewer", "sd-committer", "sd-release-manager", "sd-ops", "sd-hub-publisher", "foreman"]
}
```

- [ ] **Step 3: Commit (hub repo)**

```bash
git add agents/sd-scrum-master/manifest.json teams/self-dev-team/workflow.json
git commit -m "feat: scrum-master owns all routing, workflow.json is agents list only"
```

---

### Task 3: Scrum-master handler — NATS forwarding for routes

**Files:**
- Modify: `container/deterministic-runner/src/handlers/scrum-master.ts`

- [ ] **Step 1: Read routes from manifest**

In `loadPipeline` (or new function), also read `routes` from `/workspace/agent/manifest.json`:

```typescript
interface RoutesConfig {
  [sourceTopic: string]: string; // target agent id
}

function loadRoutes(log: HandlerContext['log']): RoutesConfig {
  const manifestPath = '/workspace/agent/manifest.json';
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { routes?: RoutesConfig };
    if (manifest.routes) {
      log.info({ count: Object.keys(manifest.routes).length }, 'Loaded routes from manifest');
      return manifest.routes;
    }
  } catch (err) {
    log.warn({ err }, 'Failed to read routes from manifest');
  }
  return {};
}
```

- [ ] **Step 2: Add NATS forwarding in message handler**

The scrum-master already receives messages on all subscribed topics (including route sources from subscribe_topics). When a message arrives, check if its subject matches a route:

At the top of the handler, load routes:
```typescript
const routes = loadRoutes(log);
```

Check if the incoming message is a route forward (not an alarm wakeup). The payload from the deterministic runner index.ts comes with the original NATS subject. Add to the handler:

```typescript
// ── 0. Route forwarding (non-alarm messages) ─────────────────────
// If this message came from a route source topic, forward to target agent
const incomingSubject = (payload as Record<string, unknown>).__subject as string | undefined;
if (incomingSubject && routes[incomingSubject]) {
  const target = routes[incomingSubject];
  try {
    await js.publish(`agent.${target}.task`, codec.encode(JSON.stringify(payload)));
    log.info({ from: incomingSubject, to: target }, 'Route: forwarded message');
  } catch (err) {
    log.error({ err, from: incomingSubject, to: target }, 'Route: forward failed');
  }
  return; // Don't process as alarm wakeup
}
```

Note: The deterministic runner needs to pass the original NATS subject to the handler. Update `container/deterministic-runner/src/index.ts` to include `__subject` in the payload:

```typescript
// In the message processing loop, add subject to payload:
(payload as Record<string, unknown>).__subject = msg.subject;
```

- [ ] **Step 3: Build + verify**

```bash
cd container/deterministic-runner && npm run build 2>&1 | tail -3
docker build -t nano-deterministic:latest . 2>&1 | tail -3
```

- [ ] **Step 4: Commit (nano-agent-team repo)**

```bash
git add container/deterministic-runner/src/handlers/scrum-master.ts container/deterministic-runner/src/index.ts
git commit -m "feat: scrum-master forwards NATS messages based on routes config"
```

---

### Task 4: Remove binding resolution from control plane

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Simplify agent startup — use subscribe_topics only**

In `src/index.ts`, the agent startup loop calls `resolveTopicsForAgent(agent.manifest, agent.binding)`. With bindings removed from workflow.json, `agent.binding` will be undefined. `resolveTopicsForAgent` already falls back to `manifest.subscribe_topics` when no binding exists — so this should work without code changes.

Verify: read `resolveTopicsForAgent` in `src/agent-registry.ts` and confirm the fallback path works when `binding` is undefined.

If the fallback works, no code change needed — just verify and document.

If not, simplify to:
```typescript
const topics = agent.manifest.subscribe_topics ?? [`agent.${getInstanceId(agent)}.inbox`];
```

- [ ] **Step 2: Run tests**

```bash
npx tsc --noEmit 2>&1 | head -10
BASE_URL=http://localhost:3002 NATS_URL=nats://localhost:4222 MCP_GATEWAY_URL=http://localhost:3004/mcp npx vitest run 2>&1 | tail -10
```

- [ ] **Step 3: Commit if changes made**

```bash
git add src/index.ts
git commit -m "refactor: control plane uses subscribe_topics from manifest, no binding resolution"
```

---

### Task 5: Deploy + E2E test

- [ ] **Step 1: Push both repos**
- [ ] **Step 2: Rebuild stack + install team**
- [ ] **Step 3: Verify all agents receive messages correctly**
- [ ] **Step 4: Create pipeline-ready ticket, verify full flow**
