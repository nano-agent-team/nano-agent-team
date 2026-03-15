# nano-agent-team

[![CI](https://github.com/nano-agent-team/nano-agent-team/actions/workflows/ci.yml/badge.svg)](https://github.com/nano-agent-team/nano-agent-team/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Self-hosted platform for autonomous AI agent teams. Agents run in isolated Docker containers, communicate via NATS JetStream, and collaborate on software development workflows end-to-end — from ticket to deployed pull request.

## How it works

```
Browser → Dashboard → Core Server → NATS JetStream → Agent Containers
                           ↕                               ↕
                        SQLite                      Claude / Codex / Gemini
```

Each agent is an independent Docker container running a Claude Code session. The core server orchestrates their lifecycle, routes NATS messages between them, and serves the dashboard UI.

## Quickstart

**Prerequisites:** Docker (or OrbStack), Claude API key or Claude Code subscription

```bash
# 1. Pull and start
docker compose up -d

# 2. Open dashboard
open http://localhost:3001

# 3. Complete setup wizard (first run)
#    → select LLM provider, enter credentials
```

First run opens a setup wizard in the browser. After setup, the dashboard is available with built-in agents (Settings, Simple Chat) ready to use.

## Installing teams from hub

Teams are installed from the [nano-agent-team/hub](https://github.com/nano-agent-team/hub) catalog via the dashboard Settings page.

The built-in **Dev Team** includes 7 agents collaborating on a ticket pipeline:

```
ticket.new → PM → Architect → Developer → Reviewer → Tester → Sysadmin → deploy
```

## LLM providers

| Provider | Auth method | Status |
|----------|-------------|--------|
| Claude | API key or Claude Code OAuth | ✅ |
| OpenAI Codex | API key or ChatGPT subscription | ✅ |
| Google Gemini | API key | 🔜 |

Agents declare capability needs (`reasoning`, `fast`, `cheap`) — the system auto-routes to the optimal model within the configured provider.

## Configuration

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Dashboard port |
| `ANTHROPIC_API_KEY` | — | Claude API key (if not using OAuth) |
| `DATA_DIR` | `~/nano-agent-team/data` | Persistent storage |
| `DOCKER_NETWORK` | `host` | `host` for Linux, `bridge` for Docker Desktop |

See `.env.example` for the full list with descriptions.

## Multiple instances

```bash
# Second instance on port 3002
PORT=3002 docker compose -p nano2 up -d
```

## Development

```bash
# Install dependencies
npm install

# Start dev server (hot reload)
npm run dev

# Type check
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev environment setup with Docker.

## Architecture

```
nano-agent-team/
├── src/                    # Core server (TypeScript)
│   ├── index.ts            # Entry point
│   ├── agent-manager.ts    # Docker container lifecycle
│   ├── agent-registry.ts   # Agent manifest loading
│   ├── api-server.ts       # Express HTTP + plugin loader
│   ├── config-service.ts   # Configuration + provider routing
│   └── nats-client.ts      # NATS JetStream client
├── dashboard/              # Built-in Vue 3 SPA
├── features/               # Feature plugins (Module Federation)
│   ├── settings/           # Setup wizard, provider config
│   ├── simple-chat/        # Direct chat with Haiku
│   └── observability/      # Traces + metrics viewer
├── container/
│   └── agent-runner/       # Agent container runtime (TypeScript)
│       └── src/providers/  # Claude, Codex, Gemini providers
├── agents/                 # Built-in agent definitions
└── docker-compose.yml
```

## License

MIT — see [LICENSE](LICENSE)
