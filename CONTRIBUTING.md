# Contributing

## Dev prostředí

### Požadavky

- Node.js 22+
- Docker (nebo OrbStack)
- `~/.claude/.credentials.json` nebo `ANTHROPIC_API_KEY` (pro testování agentů)

### Spuštění dev instance

**Pravidlo:** Live instance na portu 3001 (`nano-agent-team-project/`) se při vývoji **nikdy nedotýkáme**.
Dev instance běží na portu 3002 z adresáře `nano-agent-team-dev/`.

```bash
# Klonovat do dev adresáře
git clone git@github.com:nano-agent-team/nano-agent-team.git ~/workspace/nano-agent-team-dev
cd ~/workspace/nano-agent-team-dev

# Zkopírovat a upravit config
cp .env.example .env

# Sestavit a spustit dev stack
docker compose -f docker-compose.dev.yml up -d --build

# Dashboard na http://localhost:3002
```

### Lokální vývoj bez Dockeru

```bash
npm install
npm run dev        # core server na portu 3001 (hot reload)
```

Core server hledá lokální NATS — potřebuješ ho spustit samostatně nebo použít `docker-compose.dev.yml`.

### Struktura repozitáře

```
src/                    # Core server (TypeScript, Node.js)
dashboard/              # Dashboard SPA (Vue 3 + Vite)
features/               # Feature pluginy — každý je samostatný Module Federation remote
  settings/
    frontend/           # Vue 3 remote (buildí se samostatně)
    plugin.mjs          # Express plugin (routes, API)
    feature.json        # Manifest (routes, název, ikona)
  simple-chat/
  observability/
container/
  agent-runner/         # Kód spouštěný uvnitř agent kontejnerů (TypeScript)
    src/providers/      # Claude, Codex, Gemini provider implementace
agents/                 # Definice vestavěných agentů
```

### Přidání nového feature pluginu

1. Zkopíruj `features/simple-chat/` jako základ
2. Uprav `feature.json` — `id`, `name`, `routes`, `uiEntry`
3. Přidej komponentu do `componentRegistry` v `dashboard/src/main.ts`
4. Zaregistruj plugin v `src/api-server.ts`

### Type check

```bash
npm run build                                    # core
cd container/agent-runner && npm run build       # agent-runner
cd dashboard && npm run build                    # dashboard + features
```

### Commit konvence

```
feat: přidat Gemini provider
fix: opravit reconnect při výpadku NATS
docs: aktualizovat .env.example
refactor: zjednodušit resolveAgentProvider
```

### Pull request

- Otevři PR na `main`
- CI musí projít (type check + docker build)
- Zkontroluj PR template checklist
