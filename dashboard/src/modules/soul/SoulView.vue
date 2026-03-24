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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import MindMapView from './MindMapView.vue';
import AgentGraphView from './AgentGraphView.vue';
import { fetchSoulState, connectActivityStream, type SoulState, type ActivityEvent } from './SoulApiClient';

const view = ref<'split' | 'mindmap' | 'agents'>('split');
const soulState = ref<SoulState>({ goals: [], orphanIdeas: [], orphanPlans: [] });
const recentActivity = ref<ActivityEvent[]>([]);
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
.soul-view { display: flex; flex-direction: column; height: 100%; }
.soul-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border-color, #333); }
.soul-header h2 { margin: 0; font-size: 18px; }
.view-switcher { display: flex; gap: 4px; }
.view-switcher button { padding: 4px 12px; border: 1px solid var(--border-color, #333); background: transparent; color: inherit; border-radius: 4px; cursor: pointer; }
.view-switcher button.active { background: var(--accent-color, #7c3aed); border-color: var(--accent-color, #7c3aed); }
.soul-content { flex: 1; display: flex; overflow: hidden; }
.soul-content.split .panel { flex: 1; }
.soul-content.mindmap .panel, .soul-content.agents .panel { flex: 1; }
.panel { min-width: 0; }
</style>
