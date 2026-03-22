# Routing Agent: Scrum-Master as Configurable Router + Clean Separation

## Summary

Eliminate workflow.json bindings. Three sources of truth: agent manifests define what agents listen on, scrum-master manifest defines all routing (pipeline + event routes), workflow.json is just a team member list.

## Architecture Principle

**Each concern has exactly one owner:**

| Concern | Owner | Location |
|---------|-------|----------|
| Agent subscriptions | Each agent | `manifest.subscribe_topics` |
| Ticket pipeline routing | Scrum-master | `manifest.pipeline` |
| Event → agent forwarding | Scrum-master | `manifest.routes` |
| Team membership | Workflow | `workflow.json` (agents list only) |

No agent knows about subsequent pipeline steps. No workflow file defines routing. Control plane creates consumers from manifests, not from bindings.

## Changes

### 1. workflow.json → agents list only

Before:
```json
{
  "id": "self-dev-team",
  "agents": [...],
  "bindings": { 70+ lines of routing }
}
```

After:
```json
{
  "id": "self-dev-team",
  "agents": ["sd-pm", "sd-scrum-master", "sd-architect", "sd-developer", "sd-reviewer", "sd-committer", "sd-release-manager", "sd-ops", "sd-hub-publisher", "foreman"]
}
```

### 2. Agent manifests get subscribe_topics

Each agent that needs to listen on specific topics declares them in its manifest:

| Agent | subscribe_topics |
|-------|-----------------|
| sd-pm | `["agent.sd-pm.inbox", "agent.sd-pm.task", "topic.ticket.new"]` |
| sd-scrum-master | `["agent.sd-scrum-master.inbox", "agent.sd-scrum-master.task"]` |
| sd-architect | `["agent.sd-architect.inbox", "agent.sd-architect.task"]` |
| sd-developer | `["agent.sd-developer.inbox", "agent.sd-developer.task"]` |
| sd-reviewer | `["agent.sd-reviewer.inbox", "agent.sd-reviewer.task"]` |
| sd-committer | `["agent.sd-committer.inbox", "agent.sd-committer.task"]` |
| sd-release-manager | `["agent.sd-release-manager.inbox", "agent.sd-release-manager.task"]` |
| sd-ops | `["agent.sd-ops.inbox", "agent.sd-ops.task"]` |
| sd-hub-publisher | `["agent.sd-hub-publisher.inbox", "agent.sd-hub-publisher.task"]` |
| foreman | `["agent.foreman.inbox", "agent.foreman.task"]` |

Note: sd-ops, sd-hub-publisher, foreman no longer subscribe to event topics directly. Scrum-master forwards events to their `.task` subject via `routes` config.

### 3. Scrum-master manifest gets routes

```json
{
  "pipeline": {
    "sd-pm":              { "next": "sd-architect" },
    "sd-architect":       { "next": "sd-developer" },
    "sd-developer":       { "next": "sd-reviewer" },
    "sd-reviewer":        { "next": "sd-committer", "retry": "sd-developer" },
    "sd-committer":       { "next": "sd-release-manager" },
    "sd-release-manager": { "next": null }
  },
  "routes": {
    "topic.release.ready":  "sd-ops",
    "topic.hub.deploy":     "sd-hub-publisher",
    "topic.deploy.failed":  "foreman",
    "topic.hub.published":  "foreman",
    "topic.ticket.new":     "sd-pm"
  }
}
```

Scrum-master subscribes to these topics and forwards messages to the target agent's `.task` subject via JetStream publish.

### 4. Scrum-master handler: add NATS forwarding

On startup (first wakeup), the handler:
1. Reads `routes` from manifest
2. Creates JetStream consumers for each source topic
3. Starts forwarding loops: consume from source → publish to `agent.{target}.task`

This replaces WorkflowDispatcher for these routes.

### 5. Control plane changes

- `src/index.ts`: `ensureConsumer` reads `subscribe_topics` from manifest (already works as fallback). Remove binding resolution from workflow.json.
- `src/api-server.ts`: `start-installed` already uses `resolveTopicsForAgent(manifest)` without bindings. No change needed.
- `WorkflowDispatcher`: No longer needed for routes owned by scrum-master. Can be deprecated if no other use cases remain.
- `workflow-registry.ts`: Simplify — workflow.json no longer has bindings to parse.

### 6. What stays in WorkflowDispatcher

WorkflowDispatcher currently handles two things:
- Entrypoint routes (`from → to` forwarding) — replaced by scrum-master `routes`
- Dispatch strategies (least-busy, round-robin) — not used by self-dev-team

If no other teams use WorkflowDispatcher, it can be removed entirely. If other teams exist, it stays but self-dev-team doesn't use it.

## Migration

1. Add `subscribe_topics` to all sd-* agent manifests (hub)
2. Add `routes` to scrum-master manifest (hub)
3. Strip `bindings` from workflow.json (hub)
4. Update scrum-master handler to create consumers + forwarding loops for `routes` (nano-agent-team)
5. Remove binding resolution from control plane startup (nano-agent-team)
6. Test: verify all agents receive messages via subscribe_topics + scrum-master routing

## Components

| Component | Change |
|-----------|--------|
| `hub/agents/sd-*/manifest.json` | Add `subscribe_topics` |
| `hub/agents/sd-scrum-master/manifest.json` | Add `routes` |
| `hub/teams/self-dev-team/workflow.json` | Remove `bindings`, keep agents list |
| `container/deterministic-runner/src/handlers/scrum-master.ts` | Add NATS forwarding for `routes` |
| `src/index.ts` | Remove workflow binding resolution (use manifest subscribe_topics only) |
| `src/workflow-registry.ts` | Simplify — no binding parsing |

## Risks

| Risk | Mitigation |
|------|------------|
| Scrum-master crash stops all routing | Alarm-based restart + control plane health monitor |
| Routes config out of sync with agents | Validation at startup — warn if route target not in known agents |
| Migration breaks existing setup | subscribe_topics is already the fallback path — low risk |
