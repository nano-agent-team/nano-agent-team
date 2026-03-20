# Token Metrics & Provider Budget Management — Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Problem

The system runs multiple agents across multiple LLM providers (Anthropic, OpenAI, Gemini, local LLMs). Currently there is no visibility into:
- Token consumption per agent, team, or context
- Provider quota usage (subscription-based providers)
- Rate limit events and automatic provider fallback
- Which providers are active, on standby, or exhausted

**Goal:** Full observability of token usage + automatic provider fallback on rate limits or quota exhaustion.

---

## Provider Types

| Type | Examples | Tracking | Fallback Trigger |
|------|----------|----------|-----------------|
| Cloud Subscription | Anthropic, OpenAI | Quota % + rate limit (TPM/RPM) | Quota > threshold or rate limit spike |
| Cloud Pay-per-use | Gemini, others | $ cost + rate limit | Budget limit or rate limit spike |
| Local LLM | Ollama, LM Studio, llama.cpp | Latency + throughput | Timeout / unavailable |

---

## Architecture

### 1. Metric Emission (agent-runner)

Agent runner emits Prometheus metrics after each provider response:

```
nano_tokens_total{agent_id, model, provider, team_id, context_id, context_type, direction}
  direction: "input" | "output"

nano_tokens_cost_usd{agent_id, model, provider, team_id, context_id, context_type}
  (pay-per-use providers only; subscription = 0)

nano_provider_latency_seconds{provider, model}
  (histogram)

nano_provider_rate_limit_total{provider}
  (counter — incremented on every 429 response)

nano_provider_fallback_total{from_provider, to_provider}
  (counter — incremented on every fallback event)
```

**Dimensions:**
- `agent_id` — agent that made the request
- `model` — exact model (e.g. `claude-opus-4-6`)
- `provider` — `anthropic` | `openai` | `gemini` | `ollama` | ...
- `team_id` — team the agent belongs to
- `context_id` — generic flow identifier (ticket ID, conversation ID, WhatsApp thread ID, ...)
- `context_type` — `ticket` | `whatsapp` | `chat` | `cron` | ...

**High-cardinality mitigation:** `context_id` is high-cardinality. Recording rules pre-aggregate to lower-cardinality metrics used by dashboards and alerts:
- `nano_tokens_total:by_agent` — sum by `agent_id, model, provider`
- `nano_tokens_total:by_team` — sum by `team_id, provider`
- `nano_tokens_total:by_provider` — sum by `provider`

Raw per-`context_id` metrics are retained for 24h only (Prometheus short-retention job).

### 2. Prometheus

New service in the observability compose stack. Agent runner exposes `/metrics` on its container port. Prometheus scrapes every 15s. Control plane queries Prometheus via HTTP API (`GET http://prometheus:9090/api/v1/query`).

### 3. Budget Enforcer (`src/budget-enforcer.ts`)

**Responsibilities:**
- Decides *which provider* to use (owns the fallback decision)
- Exposes `getActiveProvider(agentId): string` — called by AgentManager when starting a new agent session
- Multi-LLM Router (#42) owns *routing execution* — Budget Enforcer tells it which provider is active

**Two data paths for rate limit detection:**

**Real-time (NATS push):** Agent runner publishes `topic.provider.rate_limit { provider, timestamp }` on every 429 response. Budget Enforcer subscribes and reacts immediately (within ms).

**Historical (Prometheus pull):** Budget Enforcer queries Prometheus every 60s for quota usage trends and long-term rate limit counts. Used for quota thresholds and dashboard data.

**Quota data from response headers:** Some providers return quota headers (e.g. `x-ratelimit-remaining-tokens`). Agent runner extracts these and publishes `topic.provider.quota { provider, remaining, limit }` via NATS. Budget Enforcer subscribes to maintain an in-memory quota estimate.

### 4. Pricing Service (`src/pricing-service.ts`)

For pay-per-use providers only. Fetches live pricing from provider APIs (Gemini Pricing API, OpenAI pricing endpoint). Update cadence: every 24h.

**Cache:** In-memory with file fallback at `/data/pricing-cache.json` (TTL: 24h). On first startup with no cache: uses bundled `src/pricing-defaults.json` (manually maintained baseline). Cache is written to disk after each successful fetch.

### 5. Provider Fallback Chain

Configured in `config.json` under `llm`:

```json
{
  "llm": {
    "fallbackChain": ["anthropic", "openai", "ollama:llama3"],
    "fallbackTriggers": {
      "quotaThresholdPercent": 90,
      "rateLimitWindow": "5m",
      "rateLimitCount": 3
    }
  }
}
```

`rateLimitCount: 3` means 3 rate limit events within a 5-minute sliding window — not a cumulative lifetime counter. The window resets after a provider is marked degraded. A provider recovers to standby after 10 minutes without rate limit events.

**Fallback behavior:**
1. Provider hits trigger → Budget Enforcer marks it `degraded`
2. `getActiveProvider()` returns next provider in chain
3. Non-critical agents (`critical: false` in manifest) are paused if all providers exhausted
4. Critical agents (`critical: true`) always receive the last available provider

**`critical` flag in AgentManifest:**
```typescript
interface AgentManifest {
  // ...existing fields...
  critical?: boolean;  // default: false
}
```

### 6. Settings UI

Settings page gains a **Provider & Budget** section:
- Drag-to-reorder fallback chain (provider pills)
- Per-provider: subscription vs pay-per-use toggle, budget limit (pay-per-use), quota threshold %
- Fallback trigger thresholds (window duration, event count)

Config persisted to `config.json` under `llm` key (same pattern as existing `providers` config).

### 7. Grafana Dashboard

Provisioned dashboard (`features/observability/compose/dashboards/token-metrics.json`):

**Row 1 — Provider Status**
Per-provider panel: quota bar (subscription) or $ spend (pay-per-use), rate limit status badge (Active / Standby / Degraded / Exhausted), latency histogram (local LLM).

**Row 2 — Throughput**
Token throughput over time, colored by active provider — fallback events visible as color transitions.

**Row 3 — Per-Agent Breakdown**
Top agents by token consumption, model used, context type.

**Row 4 — Alerting**
- Quota > 90% → warning
- Rate limit spike (3+ in 5m) → info
- All providers exhausted → critical + non-critical agents paused

---

## What Changes

| Component | Change |
|-----------|--------|
| `container/agent-runner/src/providers/*.ts` | Emit token counts + latency to `/metrics`; publish `topic.provider.rate_limit` + `topic.provider.quota` on NATS |
| `container/agent-runner/src/index.ts` | Expose `/metrics` Prometheus endpoint |
| `src/budget-enforcer.ts` | New — quota tracking, fallback decision, `getActiveProvider()` |
| `src/pricing-service.ts` | New — live pricing fetch, 24h cache, bundled defaults |
| `src/agent-manager.ts` | Call `getActiveProvider(agentId)` when starting agent; respect `critical` flag |
| `src/agent-registry.ts` | Add `critical?: boolean` to `AgentManifest` |
| `features/observability/compose/` | Add Prometheus service + recording rules |
| `features/observability/compose/dashboards/token-metrics.json` | New Grafana dashboard |
| `src/pricing-defaults.json` | New — bundled baseline pricing table |
| Settings UI | Provider fallback chain + budget configuration |

---

## Fallback Chain — Full Example

```
anthropic (subscription, primary)
  → quota > 90% OR 3× rate limit in 5m →
openai (subscription, fallback #1)
  → 3× rate limit in 5m →
ollama:llama3 (local, fallback #2, free)
  → timeout / unavailable →
PAUSE non-critical agents + alert user
```

---

## Dependencies

- Observability stack (Grafana + Loki + Tempo + Alloy) — already exists
- Multi-LLM Router (#42) — routing execution (Budget Enforcer provides the decision)
- LLM Proxy Hub Agents (#66) — per-provider proxy agents
- Secrets Service (#54) — API keys for pricing fetch

---

## Risks

- **Subscription quota via headers:** Anthropic and OpenAI return remaining quota in response headers only — not a polling API. The NATS push path from agent-runner is required; Prometheus alone is insufficient for real-time quota tracking.
- **Rate limit window accuracy:** The 5-minute sliding window is maintained in-memory by the Budget Enforcer. A control plane restart resets the window — provider may be erroneously unblocked. Acceptable tradeoff for initial implementation.
- **Local LLM availability:** Ollama may not be running on the host. Budget Enforcer should health-check local providers before including them in the fallback chain.
