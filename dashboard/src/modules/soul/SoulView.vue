<template>
  <div class="soul-view">
    <!-- View switcher (top-right) -->
    <div class="view-switcher">
      <button :class="{ active: view === 'graph' }" @click="view = 'graph'">Graf</button>
      <button :class="{ active: view === 'map' }" @click="view = 'map'">Mapa</button>
    </div>

    <!-- Main content area -->
    <div class="soul-content">
      <!-- Main area: Graph or Mind Map -->
      <AgentGraphView
        v-if="view === 'graph'"
        :activity="recentActivity"
        @select-agent="selectedAgent = $event"
        class="main-view"
      />
      <MindMapView
        v-else
        :state="soulState"
        :activity="recentActivity"
        class="main-view"
      />

      <!-- Agent Detail Panel (right side, resizable) -->
      <AgentDetailPanel
        v-if="selectedAgent"
        :agentId="selectedAgent"
        @close="selectedAgent = null"
      />
    </div>

    <!-- Chat Panel (floating bottom-right) -->
    <ChatPanel />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import MindMapView from './MindMapView.vue';
import AgentGraphView from './AgentGraphView.vue';
import AgentDetailPanel from './AgentDetailPanel.vue';
import ChatPanel from './ChatPanel.vue';
import { fetchSoulState, connectActivityStream, type SoulState, type ActivityEvent } from './SoulApiClient';

const view = ref<'graph' | 'map'>('graph');
const soulState = ref<SoulState>({ goals: [], orphanIdeas: [], orphanPlans: [] });
const recentActivity = ref<ActivityEvent[]>([]);
const selectedAgent = ref<string | null>(null);
const MAX_ACTIVITY = 200;

let stopStream: (() => void) | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  soulState.value = await fetchSoulState();

  pollInterval = setInterval(async () => {
    soulState.value = await fetchSoulState();
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
.soul-view {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0f172a;
  display: flex;
  flex-direction: column;
}

.soul-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.main-view {
  flex: 1;
  min-width: 0;
}

.view-switcher {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 20;
  display: flex;
  gap: 2px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 2px;
}

.view-switcher button {
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.view-switcher button.active {
  background: #7c3aed;
  color: #f3f4f6;
}

.view-switcher button:hover:not(.active) {
  background: #334155;
}
</style>
