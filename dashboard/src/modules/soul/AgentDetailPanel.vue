<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue';
import { fetchAgentTopology, connectAgentStream } from './SoulApiClient';
import type { AgentTopologyNode, AgentActivityEvent } from './SoulApiClient';

const props = defineProps<{
  agentId: string;
}>();
const emit = defineEmits<{
  close: [];
}>();

interface ExpandableEvent extends AgentActivityEvent {
  expanded: boolean;
}

interface Connection {
  direction: 'in' | 'out';
  target: string;
  port: string;
}

const agent = ref<AgentTopologyNode | null>(null);
const connections = ref<Connection[]>([]);
const activityEvents = ref<ExpandableEvent[]>([]);
const panelWidth = ref(350);
const isResizing = ref(false);

function startResize(e: MouseEvent) {
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = panelWidth.value;

  const onMove = (ev: MouseEvent) => {
    const delta = startX - ev.clientX;
    panelWidth.value = Math.min(Math.max(startWidth + delta, 250), window.innerWidth * 0.5);
  };
  const onUp = () => {
    isResizing.value = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

let cleanupStream: (() => void) | null = null;

function activityIcon(type: string): string {
  switch (type) {
    case 'tool_call': return '🔧';
    case 'thinking': return '💭';
    case 'text': return '💬';
    case 'signal': return '📡';
    default: return '•';
  }
}

function humanReadableLabel(event: ExpandableEvent): string {
  const name = event.toolName ?? event.summary ?? event.type;

  // MCP soul tools
  const soulMap: Record<string, string> = {
    'publish_signal': 'Signaling next step in pipeline',
    'send_to_consciousness': 'Relaying to consciousness',
    'create_idea': 'Creating new idea',
    'create_goal': 'Setting a goal',
    'create_plan': 'Writing action plan',
    'update_idea': 'Updating idea status',
    'dispatch_task': 'Dispatching task to agent',
    'list_agents': 'Discovering available agents',
    'journal_log': 'Writing to journal',
    'journal_reflect': 'Self-reflecting',
    'ask_user': 'Asking user a question',
    'answer_question': 'Answering question',
    'install_agent': 'Installing agent from hub',
    'start_agent': 'Starting agent',
    'stop_agent': 'Stopping agent',
    'get_system_status': 'Checking system status',
    'save_agent_definition': 'Creating agent definition',
    'build_agent_image': 'Building agent image',
  };

  // Strip mcp__soul__ prefix
  const bareName = name?.replace(/^mcp__soul__/, '') ?? '';
  if (soulMap[bareName]) return soulMap[bareName];

  // Built-in tools
  const builtinMap: Record<string, string> = {
    'Read': 'Reading file',
    'Write': 'Writing file',
    'Edit': 'Editing file',
    'Glob': 'Searching files',
    'Grep': 'Searching content',
    'Bash': 'Running command',
    'WebSearch': 'Searching the web',
    'WebFetch': 'Fetching URL',
    'Agent': 'Running sub-agent',
    'ToolSearch': 'Looking up tools',
  };
  if (name && builtinMap[name]) return builtinMap[name];

  // Event types
  if (event.type === 'thinking') return 'Thinking...';
  if (event.type === 'text') return 'Responding';

  // Fallback: clean up the name
  return bareName || name || event.type || 'Working';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function loadAgent(id: string) {
  const topo = await fetchAgentTopology();
  agent.value = topo.agents.find(a => a.id === id) ?? null;

  const conns: Connection[] = [];
  for (const edge of topo.edges) {
    if (edge.from === id) {
      conns.push({ direction: 'out', target: edge.to, port: edge.port });
    }
    if (edge.to === id) {
      conns.push({ direction: 'in', target: edge.from, port: edge.port });
    }
  }
  connections.value = conns;
}

function startStream(id: string) {
  cleanupStream?.();
  activityEvents.value = [];
  cleanupStream = connectAgentStream(id, (ev) => {
    const expandable: ExpandableEvent = { ...ev, expanded: false };
    const updated = [expandable, ...activityEvents.value];
    activityEvents.value = updated.slice(0, 50);
  });
}

watch(
  () => props.agentId,
  (id) => {
    if (id) {
      loadAgent(id);
      startStream(id);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  cleanupStream?.();
});
</script>

<template>
    <div class="agent-detail-panel" :style="{ width: panelWidth + 'px' }">
      <div class="resize-handle" @mousedown="startResize" />
      <!-- Header -->
      <div class="detail-header">
        <span class="detail-icon" :title="agent?.description">{{ agent?.icon || '🤖' }}</span>
        <span class="detail-name" :title="agent?.description">{{ agent?.name || agentId }}</span>
        <span class="detail-status" :class="agent?.status">{{ agent?.status }}</span>
        <button class="detail-close" @click="emit('close')">&times;</button>
      </div>

      <div class="detail-body">
        <!-- Connections -->
        <div class="detail-section" v-if="connections.length">
          <div class="section-title">Connections</div>
          <div v-for="conn in connections" :key="conn.target + conn.port" class="conn-item">
            <span class="conn-dir">{{ conn.direction === 'out' ? '→' : '←' }}</span>
            <span class="conn-agent">{{ conn.target }}</span>
            <span class="conn-port">{{ conn.port }}</span>
          </div>
        </div>

        <!-- Activity Stream -->
        <div class="detail-section">
          <div class="section-title">Activity</div>
          <div class="activity-stream">
            <div v-for="(ev, i) in activityEvents" :key="i" class="activity-item"
                 @click="ev.expanded = !ev.expanded">
              <div class="activity-summary">
                <span class="activity-icon">{{ activityIcon(ev.type) }}</span>
                <span class="activity-text">{{ humanReadableLabel(ev) }}</span>
                <span v-if="ev.inputPreview" class="activity-preview">{{ ev.inputPreview }}</span>
                <span class="activity-time">{{ formatTime(ev.timestamp) }}</span>
              </div>
              <div v-if="ev.expanded && (ev.detail || ev.text)" class="activity-detail">
                <pre v-if="ev.detail">{{ ev.detail }}</pre>
                <pre v-if="ev.text" class="llm-text">{{ ev.text }}</pre>
              </div>
            </div>
            <div v-if="activityEvents.length === 0" class="empty">No activity yet</div>
          </div>
        </div>
      </div>
    </div>
</template>

<style scoped>
.agent-detail-panel {
  position: relative;
  border-left: 1px solid #374151;
  overflow-y: auto;
  flex-shrink: 0;
  background: #111827;
  display: flex;
  flex-direction: column;
  color: #e2e8f0;
  font-family: 'Inter', sans-serif;
}

.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  z-index: 10;
}

.resize-handle:hover {
  background: #6366f1;
}

/* Header */
.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid #334155;
  flex-shrink: 0;
}

.detail-icon {
  font-size: 20px;
  cursor: default;
}

.detail-name {
  font-weight: 600;
  font-size: 15px;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.detail-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.detail-status.running {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
}
.detail-status.dead {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
}

.detail-close {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 22px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.detail-close:hover {
  color: #e2e8f0;
}

/* Body */
.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}

/* Sections */
.detail-section {
  margin-bottom: 20px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #94a3b8;
  margin-bottom: 8px;
}

/* Connections */
.conn-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 13px;
}

.conn-dir {
  color: #64748b;
  width: 16px;
  text-align: center;
}

.conn-agent {
  color: #a78bfa;
}

.conn-port {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: #6b7280;
  font-size: 11px;
}

/* Activity Stream */
.activity-stream {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.activity-item {
  background: #111827;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.activity-item:hover {
  background: #1a2234;
}

.activity-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.activity-icon {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}

.activity-text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-preview {
  color: #94a3b8;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.activity-time {
  flex-shrink: 0;
  font-size: 10px;
  color: #64748b;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}

.llm-text {
  color: #a5b4fc;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

.activity-detail {
  margin-top: 6px;
}

.activity-detail pre {
  background: #0f172a;
  font-size: 10px;
  padding: 8px;
  border-radius: 4px;
  overflow: auto;
  max-height: 200px;
  margin: 0;
  color: #cbd5e1;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.empty {
  color: #64748b;
  font-size: 13px;
  text-align: center;
  padding: 16px 0;
}
</style>
