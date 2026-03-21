<template>
  <div class="workflow-graph-wrap">
    <!-- Empty state -->
    <div v-if="!workflow && !loading" class="graph-empty">
      <span class="graph-empty-icon">⬡</span>
      <span class="graph-empty-text">No workflow loaded</span>
    </div>

    <div v-else-if="loading" class="graph-empty">
      <span class="blink">_</span> loading workflow...
    </div>

    <VueFlow
      v-else
      :nodes="nodes"
      :edges="edges"
      :default-edge-options="defaultEdgeOptions"
      :node-types="nodeTypes"
      fit-view-on-init
      :zoom-on-scroll="true"
      :pan-on-drag="true"
      class="workflow-flow"
    >
      <Background pattern-color="var(--border)" :gap="20" :size="1" />

      <!-- Custom agent node template -->
      <template #node-agent="{ data }">
        <div
          class="agent-node"
          :class="[`agent-node--${data.status ?? 'unknown'}`, { 'agent-node--busy': data.busy }]"
          @click="emit('selectAgent', data.agentId)"
        >
          <!-- Input handle -->
          <Handle type="target" :position="Position.Left" class="node-handle node-handle--left" />

          <div class="node-head">
            <span class="node-status-dot" :class="`dot-${data.status ?? 'unknown'}`" />
            <span class="node-id">{{ data.agentId }}</span>
            <span v-if="data.restartCount > 0" class="restart-badge">{{ data.restartCount }}r</span>
            <span v-if="data.busy" class="working-dots"><span /><span /><span /></span>
          </div>

          <div v-if="data.busy && data.task" class="node-task">{{ data.task }}</div>
          <div v-else class="node-status-label">{{ data.status ?? 'unknown' }}</div>

          <!-- Output handle -->
          <Handle type="source" :position="Position.Right" class="node-handle node-handle--right" />
        </div>
      </template>
    </VueFlow>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, shallowRef } from 'vue'
import { VueFlow, type Node, type Edge, Position } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Handle } from '@vue-flow/core'
import { buildGraphData } from '../utils/workflowGraph'
import type { AgentState, WorkflowManifest } from '../utils/workflowGraph'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

// ── Props / Emits ─────────────────────────────────────────────────────────────

const props = defineProps<{
  agents: AgentState[]
}>()

const emit = defineEmits<{
  (e: 'selectAgent', id: string): void
}>()

// ── State ─────────────────────────────────────────────────────────────────────

const loading = ref(true)
const workflow = ref<WorkflowManifest | null>(null)
const nodes = shallowRef<Node[]>([])
const edges = shallowRef<Edge[]>([])

const nodeTypes = { agent: 'agent' }

const defaultEdgeOptions = {
  type: 'smoothstep',
  style: { stroke: 'var(--border)', strokeWidth: 1.5 },
  labelStyle: { fill: 'var(--text-muted)', fontSize: '10px' },
  labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.85 },
}

// ── Graph rebuild ─────────────────────────────────────────────────────────────

function rebuildGraph() {
  if (!workflow.value) {
    nodes.value = []
    edges.value = []
    return
  }
  const result = buildGraphData(workflow.value, props.agents)
  nodes.value = result.nodes
  edges.value = result.edges
}

// ── Fetch workflow ─────────────────────────────────────────────────────────────

async function fetchWorkflow() {
  try {
    const res = await fetch('/api/workflow')
    const data = await res.json() as { workflow: WorkflowManifest | null }
    workflow.value = data.workflow
    rebuildGraph()
  } catch {
    // keep current state
  } finally {
    loading.value = false
  }
}

// ── Reactive status updates (no re-layout) ────────────────────────────────────

watch(() => props.agents, (newAgents) => {
  if (!workflow.value || nodes.value.length === 0) {
    rebuildGraph()
    return
  }
  // Patch node data without rebuilding layout positions
  const stateMap = new Map(newAgents.map(a => [a.agentId, a]))
  nodes.value = nodes.value.map(node => {
    const state = stateMap.get(node.id)
    if (!state) return node
    return {
      ...node,
      data: {
        agentId: node.id,
        status: state.status,
        busy: state.busy ?? false,
        task: state.task,
        restartCount: state.restartCount,
      },
    }
  })
}, { deep: true })

// ── SSE: reload workflow on plugins-updated ───────────────────────────────────

let eventSource: EventSource | null = null

function connectSSE() {
  eventSource = new EventSource('/api/events')
  eventSource.addEventListener('plugins-updated', () => {
    fetchWorkflow()
  })
  eventSource.onerror = () => {
    eventSource?.close()
    setTimeout(connectSSE, 3000)
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(() => {
  fetchWorkflow()
  connectSSE()
})

onUnmounted(() => {
  eventSource?.close()
})
</script>

<style scoped>
.workflow-graph-wrap {
  flex: 1;
  overflow: hidden;
  position: relative;
  background: var(--bg);
}

.workflow-flow {
  width: 100%;
  height: 100%;
  background: var(--bg);
}

/* Override Vue Flow defaults to match dark theme */
:deep(.vue-flow__background) {
  background: var(--bg);
}

:deep(.vue-flow__edge-path) {
  stroke: var(--border);
}

:deep(.vue-flow__edge-text) {
  fill: var(--text-muted);
  font-size: 10px;
}

:deep(.vue-flow__controls-button) {
  background: var(--surface);
  border-color: var(--border);
  color: var(--text-muted);
}

:deep(.vue-flow__controls-button:hover) {
  background: var(--surface2);
  color: var(--text);
}

/* ── Custom Agent Node ───────────────────────────────────────────────────────── */

.agent-node {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 14px;
  min-width: 160px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
  font-family: inherit;
  font-size: 12px;
  color: var(--text);
  user-select: none;
}

.agent-node:hover {
  background: var(--surface2);
  box-shadow: 0 0 0 1px var(--accent);
}

.agent-node--running   { border-color: rgba(63, 185, 80, 0.4); }
.agent-node--dead      { border-color: rgba(248, 81, 73, 0.4); }
.agent-node--starting  { border-color: rgba(88, 166, 255, 0.4); }
.agent-node--restarting   { border-color: rgba(210, 153, 34, 0.4); }
.agent-node--rolling-over { border-color: rgba(210, 153, 34, 0.4); }
.agent-node--busy      { background: rgba(240, 136, 62, 0.04); }

.node-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.node-id {
  flex: 1;
  font-weight: 600;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Status dot — same color scheme as the original agent list */
.node-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-running      { background: var(--accent2); box-shadow: 0 0 6px var(--accent2); animation: pulse-green 2.5s ease-in-out infinite; }
.dot-dead         { background: var(--danger); }
.dot-starting     { background: var(--accent); animation: pulse-blue 1.5s ease-in-out infinite; }
.dot-restarting   { background: var(--warning); animation: pulse-orange 1s ease-in-out infinite; }
.dot-rolling-over { background: var(--warning); animation: pulse-orange 1s ease-in-out infinite; }
.dot-unknown      { background: var(--border); }

@keyframes pulse-green  { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
@keyframes pulse-blue   { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
@keyframes pulse-orange { 0%,100% { opacity:1; } 50% { opacity:0.5; } }

.restart-badge {
  font-size: 9px;
  color: var(--warning);
  background: rgba(210, 153, 34, 0.15);
  padding: 1px 5px;
  border-radius: 8px;
  flex-shrink: 0;
}

.working-dots {
  display: flex;
  gap: 2px;
  align-items: center;
  flex-shrink: 0;
}
.working-dots span {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #f0883e;
  animation: wd 1.2s ease-in-out infinite;
}
.working-dots span:nth-child(2) { animation-delay: 0.2s; }
.working-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes wd { 0%,100% { opacity:0.2; } 50% { opacity:1; } }

.node-task {
  font-size: 10px;
  color: #f0883e;
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.node-status-label {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* ── Vue Flow handle overrides ───────────────────────────────────────────────── */

.node-handle {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border);
  border: 1.5px solid var(--surface);
}

.node-handle--left  { left: -4px; }
.node-handle--right { right: -4px; }

/* ── Empty state ─────────────────────────────────────────────────────────────── */

.graph-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 10px;
  color: var(--text-muted);
  font-size: 12px;
}

.graph-empty-icon {
  font-size: 28px;
  opacity: 0.3;
}

.graph-empty-text {
  letter-spacing: 0.5px;
}

.blink {
  animation: blink 1s step-end infinite;
}
@keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0; } }
</style>
