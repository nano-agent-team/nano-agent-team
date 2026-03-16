<template>
  <div class="home-root">
    <div class="home-header">
      <h1>nano-agent-team</h1>
      <div class="header-sub">Agent health overview</div>
    </div>

    <div class="agents-grid">
      <div v-if="loading" class="empty-state">Načítám...</div>
      <div v-else-if="agents.length === 0" class="empty-state">
        <div style="font-size:32px;opacity:0.2">🤖</div>
        <div>Žádní agenti — start nano-agent-team</div>
      </div>
      <div
        v-for="agent in agents"
        :key="agent.agentId"
        :class="['agent-card', `status-${agent.status}`, agent.busy ? 'agent-busy' : '']"
        @click="selectedAgentId = agent.agentId"
      >
        <div class="agent-header">
          <span class="agent-id">{{ agent.agentId }}</span>
          <span v-if="agent.busy" class="status-badge status-busy">pracuje</span>
          <span v-else :class="`status-badge status-${agent.status}`">{{ agent.status }}</span>
        </div>
        <div v-if="agent.busy && agent.task" class="agent-task">
          {{ agent.task }}
        </div>
        <div class="agent-meta">
          <div v-if="agent.startedAt">
            <span class="meta-label">Started</span>
            <span class="meta-value">{{ relTime(agent.startedAt) }}</span>
          </div>
          <div v-if="agent.lastHeartbeat">
            <span class="meta-label">Heartbeat</span>
            <span class="meta-value">{{ relTime(agent.lastHeartbeat) }}</span>
          </div>
          <div>
            <span class="meta-label">Restarts</span>
            <span class="meta-value">{{ agent.restartCount }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ agents.filter(a => a.status === 'running').length }}</div>
        <div class="stat-label">Running</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ agents.filter(a => a.status === 'dead').length }}</div>
        <div class="stat-label">Dead</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ agents.length }}</div>
        <div class="stat-label">Total</div>
      </div>
    </div>

    <AgentModal v-if="selectedAgentId" :agentId="selectedAgentId" @close="selectedAgentId = null" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { relTime } from '../../utils/time'
import AgentModal from '../../components/AgentModal.vue'

interface AgentState {
  agentId: string
  status: 'starting' | 'running' | 'dead' | 'restarting'
  restartCount: number
  startedAt?: string
  lastHeartbeat?: string
  containerId?: string
  busy?: boolean
  task?: string
}

const agents = ref<AgentState[]>([])
const loading = ref(true)
const selectedAgentId = ref<string | null>(null)

async function loadHealth() {
  try {
    const res = await fetch('/api/health')
    const data = await res.json()
    agents.value = Array.isArray(data.agents) ? data.agents : []
  } catch (e) {
    console.error('loadHealth error', e)
  } finally {
    loading.value = false
  }
}

let interval: ReturnType<typeof setInterval>

onMounted(() => {
  loadHealth()
  interval = setInterval(loadHealth, 15000)
})

onUnmounted(() => clearInterval(interval))
</script>

<style scoped>
.home-root {
  padding: 24px;
  overflow-y: auto;
  height: calc(100vh - 40px);
}

.home-header {
  margin-bottom: 24px;
}

.home-header h1 {
  font-size: 22px;
  color: var(--accent);
  font-weight: 700;
  letter-spacing: 2px;
}

.header-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-muted);
  padding: 40px;
  grid-column: 1 / -1;
}

.agent-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  transition: border-color 0.2s;
}

.agent-card { cursor: pointer; }
.agent-card:hover { border-color: var(--accent); }
.agent-card.status-running { border-left: 3px solid var(--accent2); }
.agent-card.status-dead { border-left: 3px solid var(--danger); }
.agent-card.status-starting { border-left: 3px solid var(--accent); }
.agent-card.status-restarting { border-left: 3px solid var(--warning); }

.agent-card.agent-busy {
  border-left: 3px solid #f0883e;
  background: rgba(240, 136, 62, 0.06);
  animation: busy-pulse 2s ease-in-out infinite;
}

@keyframes busy-pulse {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 8px rgba(240, 136, 62, 0.2); }
}

.agent-task {
  font-size: 12px;
  color: #f0883e;
  padding: 4px 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.agent-id {
  font-size: 14px;
  color: var(--text);
  font-weight: 600;
}

.status-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 600;
}

.status-running { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
.status-dead { background: rgba(248, 81, 73, 0.15); color: #f85149; }
.status-starting { background: rgba(88, 166, 255, 0.15); color: #58a6ff; }
.status-restarting { background: rgba(210, 153, 34, 0.15); color: #d29922; }
.status-busy { background: rgba(240, 136, 62, 0.15); color: #f0883e; }

.agent-meta { display: flex; flex-direction: column; gap: 4px; }
.agent-meta > div { display: flex; justify-content: space-between; font-size: 11px; }
.meta-label { color: var(--text-muted); }
.meta-value { color: var(--text); }

.stats-row {
  display: flex;
  gap: 12px;
}

.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 24px;
  text-align: center;
  min-width: 100px;
}

.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--accent);
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  letter-spacing: 1px;
  text-transform: uppercase;
}
</style>
