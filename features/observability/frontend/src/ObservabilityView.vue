<template>
  <div class="obs-view">
    <div class="obs-header">
      <h1>Observability</h1>
      <div class="header-actions">
        <select v-model="timeRange" class="time-select" @change="refresh">
          <option value="15m">15 min</option>
          <option value="1h">1 hodina</option>
          <option value="3h">3 hodiny</option>
          <option value="12h">12 hodin</option>
          <option value="24h">24 hodin</option>
        </select>
        <button class="btn-refresh" @click="refresh" :disabled="loading">
          {{ loading ? '...' : 'Obnovit' }}
        </button>
      </div>
    </div>

    <!-- Not configured -->
    <div v-if="status.level === 'none'" class="panel panel-empty">
      <p>Observability není aktivní.</p>
      <p class="hint">Zapni ji v <a href="/settings">Settings</a>.</p>
    </div>

    <!-- Stack not running -->
    <div v-else-if="status.provider === 'builtin' && !status.composeRunning" class="panel panel-empty">
      <p>Stack neběží.</p>
      <button class="btn-primary" @click="startStack" :disabled="starting">
        {{ starting ? 'Spouštím...' : 'Spustit stack' }}
      </button>
    </div>

    <template v-else>
      <!-- Ticket Pipeline -->
      <section class="panel">
        <h2>Ticket Pipeline</h2>
        <div v-if="traces.length === 0 && !loading" class="empty">Zatím žádné traces.</div>
        <div v-else class="trace-list">
          <div
            v-for="t in traces"
            :key="t.traceID"
            class="trace-row"
            :class="{ 'trace-row--expanded': expandedTrace === t.traceID }"
            @click="toggleTrace(t.traceID)"
          >
            <div class="trace-summary">
              <span class="trace-name">{{ t.rootTraceName }}</span>
              <span class="trace-service">{{ t.rootServiceName?.replace('nano-', '') }}</span>
              <span v-if="t.durationMs" class="trace-duration">{{ formatDuration(t.durationMs) }}</span>
              <span class="trace-time">{{ formatTime(t.startTimeUnixNano) }}</span>
            </div>

            <!-- Expanded: show spans -->
            <div v-if="expandedTrace === t.traceID" class="trace-detail" @click.stop>
              <div v-if="traceDetail[t.traceID]?.loading" class="loading">Načítám...</div>
              <div v-else-if="traceDetail[t.traceID]?.spans" class="span-list">
                <div
                  v-for="span in traceDetail[t.traceID].spans"
                  :key="span.spanID"
                  class="span-row"
                  :style="{ paddingLeft: (span.depth * 20 + 8) + 'px' }"
                >
                  <span class="span-svc">{{ span.service?.replace('nano-', '') }}</span>
                  <span class="span-name">{{ span.operationName }}</span>
                  <span class="span-dur">{{ formatDuration(span.durationMs) }}</span>
                  <div v-if="span.tags?.length" class="span-tags">
                    <span v-for="tag in span.tags" :key="tag.key" class="span-tag">
                      {{ tag.key }}={{ tag.value }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Agent Activity -->
      <section class="panel">
        <h2>Agent Activity</h2>
        <div v-if="agentActivity.length === 0 && !loading" class="empty">Agenti zatím nic nezpracovali.</div>
        <table v-else class="activity-table">
          <colgroup>
            <col style="width: 100px" />
            <col />
            <col style="width: 110px" />
            <col style="width: 80px" />
            <col style="width: 80px" />
          </colgroup>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Akce</th>
              <th>Událost</th>
              <th>Doba</th>
              <th>Čas</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in agentActivity" :key="a.spanID">
              <td><span class="agent-badge">{{ a.agent }}</span></td>
              <td class="activity-action cell-ellipsis">{{ a.action }}</td>
              <td><code v-if="a.ticketId">{{ a.ticketId }}</code></td>
              <td class="activity-dur">{{ formatDuration(a.durationMs) }}</td>
              <td class="activity-time">{{ formatTime(a.startNano) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

    </template>

    <div v-if="error" class="error-msg">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'

interface Trace {
  traceID: string
  rootServiceName: string
  rootTraceName: string
  startTimeUnixNano: string
  durationMs?: number
}

interface SpanInfo {
  spanID: string
  operationName: string
  service: string
  durationMs: number
  depth: number
  tags: { key: string; value: string }[]
}

interface TraceDetailCache {
  loading: boolean
  spans?: SpanInfo[]
}

const status = reactive({ level: 'none', provider: 'builtin', composeRunning: false })
interface AgentActivityItem {
  spanID: string
  agent: string
  action: string
  ticketId: string
  durationMs: number
  startNano: string
}

const traces = ref<Trace[]>([])
const agentActivity = ref<AgentActivityItem[]>([])
const loading = ref(false)
const starting = ref(false)
const error = ref('')
const timeRange = ref('3h')
const expandedTrace = ref<string | null>(null)
const traceDetail = reactive<Record<string, TraceDetailCache>>({})

function formatTime(nanos: string): string {
  const ms = parseInt(nanos) / 1_000_000
  const d = new Date(ms)
  return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) {
    const s = ms / 1000
    return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
  }
  const min = Math.floor(ms / 60000)
  const sec = Math.round((ms % 60000) / 1000)
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/observability/status')
    if (res.ok) Object.assign(status, await res.json())
  } catch { /* ignore */ }
}

async function fetchTraces() {
  loading.value = true
  error.value = ''
  try {
    // Business traces — ticket lifecycle
    const res = await fetch(`/api/observability/traces?q=${encodeURIComponent('{}')}&limit=30`)
    if (res.ok) {
      const data = await res.json() as { traces: Trace[] }
      traces.value = (data.traces ?? []).filter(t => t.rootTraceName && !t.rootTraceName.includes('not yet'))
    }

    // Agent activity — fetch agent traces and extract individual spans
    const res2 = await fetch(`/api/observability/traces?q=${encodeURIComponent('{resource.service.name =~ "nano-agent-.*"}')}&limit=30`)
    if (res2.ok) {
      const data2 = await res2.json() as { traces: Trace[] }
      const activities: AgentActivityItem[] = []

      // Fetch detail for each agent trace to get span info
      for (const t of (data2.traces ?? []).slice(0, 15)) {
        try {
          const dr = await fetch(`/api/observability/trace/${t.traceID}`)
          if (!dr.ok) continue
          const detail = await dr.json() as { batches?: unknown[] }
          for (const batch of detail.batches ?? []) {
            const b = batch as {
              resource?: { attributes?: { key: string; value: { stringValue?: string } }[] }
              scopeSpans?: { spans?: {
                spanId: string; name: string;
                startTimeUnixNano?: string; endTimeUnixNano?: string;
                attributes?: { key: string; value: { stringValue?: string } }[]
              }[] }[]
            }
            const svc = b.resource?.attributes?.find(a => a.key === 'service.name')?.value?.stringValue ?? ''
            if (!svc.startsWith('nano-agent-')) continue

            for (const scope of b.scopeSpans ?? []) {
              for (const s of scope.spans ?? []) {
                // Only show top-level agent spans (agent.process equivalent), not claude.query/nats.publish
                if (s.name === 'claude.query' || s.name === 'nats.publish') continue
                const agent = svc.replace('nano-agent-', '')
                const ticketId = s.attributes?.find(a => a.key === 'ticket.id')?.value?.stringValue ?? ''
                const startNs = parseInt(s.startTimeUnixNano ?? '0')
                const endNs = parseInt(s.endTimeUnixNano ?? '0')
                const durMs = Math.round((endNs - startNs) / 1_000_000)
                activities.push({
                  spanID: s.spanId,
                  agent,
                  action: s.name,
                  ticketId,
                  durationMs: durMs,
                  startNano: s.startTimeUnixNano ?? '0',
                })
              }
            }
          }
        } catch { /* skip */ }
      }

      // Sort newest first
      activities.sort((a, b) => parseInt(b.startNano) - parseInt(a.startNano))
      agentActivity.value = activities
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function toggleTrace(traceId: string) {
  if (expandedTrace.value === traceId) {
    expandedTrace.value = null
    return
  }
  expandedTrace.value = traceId

  if (traceDetail[traceId]) return

  traceDetail[traceId] = { loading: true }
  try {
    const res = await fetch(`/api/observability/trace/${traceId}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { batches?: unknown[] }

    // Parse Tempo trace response into flat span list
    const spans: SpanInfo[] = []
    const parentMap = new Map<string, string>()

    for (const batch of data.batches ?? []) {
      const b = batch as {
        resource?: { attributes?: { key: string; value: { stringValue?: string } }[] }
        scopeSpans?: { spans?: {
          spanId: string; name: string; parentSpanId?: string;
          startTimeUnixNano?: string; endTimeUnixNano?: string;
          attributes?: { key: string; value: { stringValue?: string; intValue?: string } }[]
        }[] }[]
      }
      const svcAttr = b.resource?.attributes?.find(a => a.key === 'service.name')
      const service = svcAttr?.value?.stringValue ?? 'unknown'

      for (const scope of b.scopeSpans ?? []) {
        for (const s of scope.spans ?? []) {
          if (s.parentSpanId) parentMap.set(s.spanId, s.parentSpanId)
          const startNs = parseInt(s.startTimeUnixNano ?? '0')
          const endNs = parseInt(s.endTimeUnixNano ?? '0')
          const durMs = Math.round((endNs - startNs) / 1_000_000)
          const tags = (s.attributes ?? [])
            .filter(a => ['ticket.id', 'ticket.title', 'agent.id', 'session.id', 'claude.model'].includes(a.key))
            .map(a => ({ key: a.key, value: a.value.stringValue ?? a.value.intValue ?? '' }))
          spans.push({ spanID: s.spanId, operationName: s.name, service, durationMs: durMs, depth: 0, tags })
        }
      }
    }

    // Calculate depth
    function getDepth(spanId: string, visited = new Set<string>()): number {
      if (visited.has(spanId)) return 0
      visited.add(spanId)
      const parent = parentMap.get(spanId)
      if (!parent) return 0
      return 1 + getDepth(parent, visited)
    }
    for (const s of spans) s.depth = getDepth(s.spanID)

    // Sort by depth (root first)
    spans.sort((a, b) => a.depth - b.depth)

    traceDetail[traceId] = { loading: false, spans }
  } catch {
    traceDetail[traceId] = { loading: false, spans: [] }
  }
}

async function startStack() {
  starting.value = true; error.value = ''
  try {
    await fetch('/api/observability/start', { method: 'POST' })
    await new Promise(r => setTimeout(r, 8000))
    await fetchStatus()
    if (status.composeRunning) await fetchTraces()
  } catch (e) { error.value = String(e) }
  finally { starting.value = false }
}

async function refresh() {
  await fetchTraces()
}

onMounted(async () => {
  await fetchStatus()
  if (status.level !== 'none' && status.composeRunning) {
    await fetchTraces()
  }
})
</script>

<style scoped>
.obs-view {
  width: 100%;
  max-width: 100%;
  padding: 20px 24px;
  color: var(--text, #e6edf3);
  box-sizing: border-box;
  overflow: hidden;
}

.obs-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px;
}
h1 { font-size: 20px; font-weight: 700; margin: 0; }
h2 { font-size: 13px; font-weight: 600; color: var(--text-muted, #8b949e); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 12px; }

.header-actions { display: flex; gap: 8px; align-items: center; }

.time-select {
  padding: 5px 10px; background: var(--surface, #161b22); border: 1px solid var(--border, #30363d);
  border-radius: 6px; color: var(--text, #e6edf3); font-size: 13px; outline: none;
}

.btn-refresh {
  padding: 5px 14px; background: var(--surface, #161b22); border: 1px solid var(--border, #30363d);
  border-radius: 6px; color: var(--text, #e6edf3); font-size: 13px; cursor: pointer;
}
.btn-refresh:hover { border-color: var(--accent, #58a6ff); }
.btn-refresh:disabled { opacity: 0.5; }

.panel {
  background: var(--surface, #161b22); border: 1px solid var(--border, #30363d);
  border-radius: 8px; padding: 16px 20px; margin-bottom: 16px;
  overflow: hidden; min-width: 0;
}
.panel-empty { text-align: center; padding: 48px 20px; }
.panel-empty p { margin: 0 0 12px; font-size: 15px; }
.panel-empty a { color: var(--accent, #58a6ff); }
.hint { font-size: 13px; color: var(--text-muted, #8b949e); }
.empty { font-size: 13px; color: var(--text-muted, #8b949e); text-align: center; padding: 16px; }
.loading { font-size: 13px; color: var(--text-muted, #8b949e); padding: 8px; }

/* Trace list */
.trace-list { display: flex; flex-direction: column; gap: 2px; }

.trace-row {
  border: 1px solid var(--border, #30363d); border-radius: 6px;
  cursor: pointer; transition: border-color 0.1s; overflow: hidden;
  min-width: 0; /* prevent content from stretching parent */
}
.trace-row:hover { border-color: var(--accent, #58a6ff); }
.trace-row--expanded { border-color: var(--accent, #58a6ff); }

.trace-summary {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  min-width: 0; /* allow children to shrink */
}

.trace-name {
  font-size: 13px; font-weight: 600; flex: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.trace-service {
  font-size: 11px; padding: 2px 8px;
  background: rgba(88, 166, 255, 0.1); color: var(--accent, #58a6ff);
  border-radius: 4px; white-space: nowrap;
}

.trace-duration {
  font-size: 11px; color: var(--text-muted, #8b949e);
  font-family: monospace; white-space: nowrap;
}

.trace-time {
  font-size: 11px; color: var(--text-muted, #8b949e);
  white-space: nowrap;
}

/* Trace detail (expanded) */
.trace-detail {
  border-top: 1px solid var(--border, #30363d);
  background: var(--bg, #0d1117);
  padding: 8px 0;
  overflow: hidden;
}

.span-list { display: flex; flex-direction: column; }

.span-row {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 14px; font-size: 12px;
  border-left: 2px solid transparent;
  min-width: 0;
}
.span-row:hover { background: rgba(255,255,255,0.02); border-left-color: var(--accent, #58a6ff); }

.span-svc {
  font-size: 10px; padding: 1px 6px;
  background: rgba(63, 185, 80, 0.1); color: #3fb950;
  border-radius: 3px; white-space: nowrap;
  min-width: 50px; text-align: center;
}

.span-name { font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.span-dur { font-family: monospace; color: var(--text-muted, #8b949e); font-size: 11px; }

.span-tags {
  display: flex; gap: 6px; flex-wrap: wrap; flex-shrink: 0;
}
.span-tag {
  font-size: 10px; padding: 1px 6px;
  background: rgba(139, 148, 158, 0.1); color: var(--text-muted, #8b949e);
  border-radius: 3px; font-family: monospace;
}

/* Agent activity table */
.activity-table {
  width: 100%; border-collapse: collapse; font-size: 13px;
  table-layout: fixed;
}
.activity-table colgroup col:nth-child(1) { width: 100px; }
.activity-table colgroup col:nth-child(2) { width: auto; }
.activity-table colgroup col:nth-child(3) { width: 100px; }
.activity-table colgroup col:nth-child(4) { width: 80px; }
.activity-table colgroup col:nth-child(5) { width: 80px; }
.activity-table th {
  text-align: left; padding: 6px 10px; font-size: 11px; font-weight: 600;
  color: var(--text-muted, #8b949e); text-transform: uppercase; letter-spacing: 0.03em;
  border-bottom: 1px solid var(--border, #30363d);
}
.activity-table td {
  padding: 8px 10px; border-bottom: 1px solid rgba(48, 54, 61, 0.5);
}
.activity-table tr:hover td { background: rgba(255,255,255,0.02); }
.agent-badge {
  font-size: 11px; padding: 2px 8px; border-radius: 4px; white-space: nowrap;
  background: rgba(63, 185, 80, 0.1); color: #3fb950; font-weight: 600;
}
.activity-action { font-weight: 500; }
.cell-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 0; }
.activity-dur { font-family: monospace; color: var(--text-muted, #8b949e); white-space: nowrap; }
.activity-time { color: var(--text-muted, #8b949e); white-space: nowrap; }
.activity-table code {
  font-size: 12px; background: rgba(88,166,255,0.1); color: var(--accent, #58a6ff);
  padding: 1px 6px; border-radius: 3px;
}

.btn-primary {
  padding: 10px 24px; background: var(--accent, #58a6ff); color: #0d1117;
  border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.error-msg {
  background: rgba(248, 81, 73, 0.1); border: 1px solid #f85149;
  border-radius: 6px; padding: 10px 14px; color: #f85149;
  font-size: 13px; margin-top: 12px;
}
</style>
