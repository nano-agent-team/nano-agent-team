<template>
  <div class="soul-view">
    <div class="soul-header">
      <h2>🧠 Thinking</h2>
      <div class="view-switcher">
        <button :class="{ active: view === 'split' }" @click="view = 'split'">Split</button>
        <button :class="{ active: view === 'mindmap' }" @click="view = 'mindmap'">Mind Map</button>
        <button :class="{ active: view === 'agents' }" @click="view = 'agents'">Agents</button>
      </div>
    </div>
    <div class="soul-main">
      <div class="soul-content" :class="view">
        <MindMapView
          v-if="view === 'split' || view === 'mindmap'"
          :state="soulState"
          :activity="recentActivity"
          class="panel"
        />
        <AgentGraphView
          v-if="view === 'split' || view === 'agents'"
          :activity="recentActivity"
          class="panel"
        />
      </div>
      <div class="journal-panel">
        <div class="journal-header">
          <span class="journal-title">💭 Thought Journal</span>
          <span class="journal-count">{{ journal.length }}</span>
        </div>
        <div class="journal-entries">
          <div v-if="journal.length === 0" class="journal-empty">
            No thoughts yet...
          </div>
          <div
            v-for="(entry, idx) in journal"
            :key="idx"
            class="journal-entry"
          >
            <div class="entry-meta">
              <span class="entry-agent">{{ entry.agent }}</span>
              <span class="entry-time">{{ formatTime(entry.timestamp) }}</span>
            </div>
            <div class="entry-text">{{ entry.text }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import MindMapView from './MindMapView.vue';
import AgentGraphView from './AgentGraphView.vue';
import { fetchSoulState, connectActivityStream, type SoulState, type ActivityEvent } from './SoulApiClient';

interface JournalEntry {
  timestamp: string;
  agent: string;
  text: string;
}

const view = ref<'split' | 'mindmap' | 'agents'>('split');
const soulState = ref<SoulState>({ goals: [], orphanIdeas: [], orphanPlans: [] });
const recentActivity = ref<ActivityEvent[]>([]);
const journal = ref<JournalEntry[]>([]);
const MAX_ACTIVITY = 200;

let stopStream: (() => void) | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function fetchJournal() {
  try {
    const res = await fetch('/api/soul/journal');
    if (res.ok) journal.value = await res.json();
  } catch { /* ignore */ }
}

function formatTime(ts: string): string {
  // ts format: "2026-03-24T10:28:16"
  const timePart = ts.includes('T') ? ts.split('T')[1] : ts;
  return timePart.slice(0, 8);
}

onMounted(async () => {
  soulState.value = await fetchSoulState();
  await fetchJournal();

  pollInterval = setInterval(async () => {
    soulState.value = await fetchSoulState();
    await fetchJournal();
  }, 5000);

  stopStream = connectActivityStream((event) => {
    recentActivity.value = [...recentActivity.value.slice(-(MAX_ACTIVITY - 1)), event];
  });
});

onUnmounted(() => {
  stopStream?.();
  if (pollInterval) clearInterval(pollInterval);
});
</script>

<style scoped>
.soul-view { display: flex; flex-direction: column; height: 100%; }
.soul-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border-color, #333); }
.soul-header h2 { margin: 0; font-size: 18px; }
.view-switcher { display: flex; gap: 4px; }
.view-switcher button { padding: 4px 12px; border: 1px solid var(--border-color, #333); background: transparent; color: inherit; border-radius: 4px; cursor: pointer; }
.view-switcher button.active { background: var(--accent-color, #7c3aed); border-color: var(--accent-color, #7c3aed); }

.soul-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.soul-content { flex: 1; display: flex; overflow: hidden; min-height: 0; }
.soul-content.split .panel { flex: 1; }
.soul-content.mindmap .panel, .soul-content.agents .panel { flex: 1; }
.panel { min-width: 0; }

.journal-panel {
  height: 220px;
  min-height: 180px;
  border-top: 1px solid #374151;
  display: flex;
  flex-direction: column;
  background: #111827;
}

.journal-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid #1f2937;
}

.journal-title {
  font-size: 13px;
  font-weight: 600;
  color: #c4b5fd;
}

.journal-count {
  font-size: 11px;
  color: #6b7280;
  background: #1f2937;
  padding: 1px 6px;
  border-radius: 8px;
}

.journal-entries {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
}

.journal-empty {
  color: #6b7280;
  font-size: 13px;
  padding: 16px 0;
  text-align: center;
}

.journal-entry {
  margin-bottom: 12px;
  padding: 8px 10px;
  background: #1e293b;
  border-radius: 6px;
  border-left: 3px solid #7c3aed;
}

.entry-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.entry-agent {
  font-size: 11px;
  font-weight: 600;
  color: #a78bfa;
  text-transform: uppercase;
}

.entry-time {
  font-size: 11px;
  color: #6b7280;
  font-family: monospace;
}

.entry-text {
  font-size: 12px;
  color: #d1d5db;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
