## Context

Hot-swap an agent's definition (CLAUDE.md, manifest.json) without rebuilding. Use when you changed files in hub/agents/{id}/ and want to test immediately.

## Your Task

Hot-swap agent definition into the running instance.

### Usage

The user will say `/nat-hotswap {agent-id}` (e.g. `/nat-hotswap consciousness`).

### Steps

1. **Copy files** from hub into the running container:
   ```bash
   docker cp /Users/rpridal/workspace/nano-agent-team-project/hub/agents/{id}/. nate:/data/agents/{id}/
   ```

2. **Reload agent** via internal API (from inside the container):
   ```bash
   docker exec nate wget -qO- --post-data='{}' --header='Content-Type: application/json' http://127.0.0.1:3001/internal/agents/{id}/reload
   ```

3. **Verify** the agent restarted:
   ```bash
   curl -s http://localhost:3001/api/health | python3 -c "import json,sys; d=json.load(sys.stdin); [print(a['agentId'], a['status']) for a in d['agents'] if a['agentId']=='{id}']"
   ```

4. Tell the user the agent is reloaded and ready.

### Notes
- No rebuild needed — this takes seconds, not minutes
- Works for CLAUDE.md, manifest.json, PRINCIPLES.md — any file in the agent definition
- Agent session is reset (new conversation context)
- Does NOT work for changes to agent-runner code or container image — use /nat-agent-rebuild for that
