# Contributing

## Development Environment

### Requirements

- Node.js 22+
- Docker (or OrbStack)
- `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY` (for agent testing)

### Starting the Dev Instance

**Rule:** The live instance on port 3001 (`nano-agent-team-project/`) is **never touched** during development.
Dev instance runs on port 3002 from the `nano-agent-team-dev/` directory.

```bash
# Clone into dev directory
git clone git@github.com:nano-agent-team/nano-agent-team.git ~/workspace/nano-agent-team-dev
cd ~/workspace/nano-agent-team-dev

# Copy and configure
cp .env.example .env

# Build and start dev stack
docker compose -f docker-compose.dev.yml up -d --build

# Dashboard at http://localhost:3002
```

### Local Development Without Docker

```bash
npm install
PORT=3002 npm run dev   # core server on port 3002 to avoid conflict with live instance
```

> **Warning:** The default port is 3001. Always set `PORT=3002` when running locally to avoid interfering with the live instance on port 3001.

The core server requires a local NATS instance — start it separately or use `docker-compose.dev.yml`.

### Repository Structure

```
src/                    # Core server (TypeScript, Node.js)
dashboard/              # Dashboard SPA (Vue 3 + Vite)
features/               # Feature plugins — each is a standalone Module Federation remote
  settings/
    frontend/           # Vue 3 remote (built separately)
    plugin.mjs          # Express plugin (routes, API)
    feature.json        # Manifest (routes, name, icon)
  simple-chat/
  observability/
container/
  agent-runner/         # Code running inside agent containers (TypeScript)
    src/providers/      # Claude, Codex, Gemini provider implementations
agents/                 # Built-in agent definitions
```

### Adding a New Feature Plugin

1. Copy `features/simple-chat/` as a starting point
2. Edit `feature.json` — `id`, `name`, `routes`, `uiEntry`
3. Add component to `componentRegistry` in `dashboard/src/main.ts`
4. Register plugin in `src/api-server.ts`

### Type Check

```bash
npm run build                                                # core
cd container/agent-runner && npm run build               # agent-runner
cd dashboard && npm run build                            # dashboard
cd features/settings/frontend && npm run build           # feature: settings
cd features/simple-chat/frontend && npm run build        # feature: simple-chat
cd features/observability/frontend && npm run build      # feature: observability
```

## Commit Convention

**Language: English only.** All commit messages, PR titles, descriptions, and comments on GitHub must be in English.

### Format

```
<type>(<scope>): <description>
```

or without scope:

```
<type>: <description>
```

### Types (closed list)

| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code restructuring without behavior change |
| `test` | Adding or fixing tests |
| `chore` | Build scripts, tooling, dependencies |
| `ci` | CI/CD workflow changes |

### Scopes (closed list)

`api` | `dashboard` | `agent-runner` | `hub` | `settings` | `observability` | `docker` | `security` | `ci`

### Examples

```
feat(api): add Gemini provider support
fix(agent-runner): handle NATS reconnect on disconnect
docs: update .env.example with new variables
refactor(dashboard): simplify agent provider resolution
chore(docker): upgrade base image to node:22-alpine
```

### Rules

- Description in English, max 72 characters
- No vague messages: avoid starting with "apply", "update", "various", "misc"
- Describe **what** and **why**, not just the steps taken

These rules are enforced by commitlint — invalid messages will be rejected at commit time.

## Branch Naming

Pattern: `<type>/<short-description>` or `<type>/<issue-id>-<short-description>`

Examples:
- `feat/agent-customization`
- `fix/123-hub-reinstall`
- `docs/contributing-english`

## Pull Request

- Open PR against `main`
- CI must pass (type check + docker build)
- Complete the PR template checklist

## Security

- **Never commit secrets** — `.env`, `*.pem`, `*.key`, `credentials.json` are blocked by pre-commit hook
- If you add new environment variables, update `.env.example`
- API and `feature.json` changes must be backward compatible
