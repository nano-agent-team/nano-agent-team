# Project Vision

## Mission

**nano-agent-team** is a self-hosted runtime platform for autonomous AI agent teams. It orchestrates agent containers, routes messages between them, and provides a dashboard for monitoring and configuration.

> The companion [hub](https://github.com/nano-agent-team/hub) repository is a public catalog of team and agent definitions that can be installed into this platform.

## What This Project Is

```
Browser → Dashboard → Core Server → NATS JetStream → Agent Containers
                           ↕                               ↕
                        SQLite                      Claude / Codex / Gemini
```

- **Runtime orchestrator** — starts, stops, and monitors agent Docker containers
- **Message broker bridge** — routes NATS JetStream messages between agents
- **Dashboard** — web UI for health monitoring, ticket management, and agent configuration
- **Installation target** — teams from hub are installed and run here

## In Scope

### ✅ Included in This Project

- Agent container lifecycle management (start, stop, restart, health monitoring)
- NATS JetStream message routing between agents
- Dashboard UI — health overview, ticket board, agent configuration, settings (including monitoring enhancements and real-time observability improvements)
- **Agent customization** — per-agent model overrides and custom instructions via `data/vault/`
- LLM provider configuration (Claude, Codex, Gemini)
- Team and feature installation from hub catalog
- Observability (OpenTelemetry, Grafana/Tempo integration)
- MCP server integration (tickets, filesystem, git)

## Out of Scope

### ❌ NOT Part of This Project

- **Agent definitions** — team/agent manifests and CLAUDE.md prompts live in [hub](https://github.com/nano-agent-team/hub)
- **Agent training or fine-tuning** — Claude models are used as-is via API
- **Custom LLM hosting** — only Anthropic Claude, OpenAI Codex, and Google Gemini
- **General-purpose CI/CD** — purpose-built for AI agent workflows, not arbitrary automation
- **Multi-tenant SaaS** — designed for self-hosted, single-team use

## Principles

### 1. Runtime First
The platform exists to run agents reliably. Features that improve agent reliability, visibility, or configurability are in scope.

### 2. Dashboard as Control Plane
The dashboard is the primary operator interface — health monitoring, configuration, and management all belong here.

### 3. Data Isolation
User customizations (`data/vault/`) are local and gitignored. The platform ships with sane defaults; customization is opt-in.

### 4. Provider Agnostic
Agents declare capability needs (`reasoning`, `fast`, `cheap`). The platform routes to the right model — the agent doesn't care which provider is configured.

### 5. Security
- Secrets never committed to git
- Agent containers run isolated (Docker)
- API inputs validated before touching the filesystem

## Feature Evaluation

When proposing a new feature, ask:

| Criterion | Question |
|-----------|----------|
| **Runtime value** | Does this make agents more reliable, observable, or configurable? |
| **Operator UX** | Does this help the person running the platform understand or control it? |
| **Simplicity** | Is the minimum complexity used to solve the problem? |
| **Security** | Are all inputs validated? No secrets exposed? |

---

**Last Updated**: 2026-03-17
**Maintained By**: nano-agent-team contributors
