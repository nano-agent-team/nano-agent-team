<template>
  <div class="mind-map-tree">
    <div class="tree-header">
      <h3>🗺️ Mind Map</h3>
      <label class="toggle-completed">
        <input type="checkbox" v-model="showCompleted" />
        Show completed
      </label>
    </div>

    <div class="tree-content">
      <!-- Goals -->
      <div v-for="goal in filteredGoals" :key="goal.id" class="tree-node goal-node">
        <div class="node-header" @click="toggle(goal.id)">
          <span class="expand-icon">{{ expanded[goal.id] ? '▼' : '▶' }}</span>
          <span class="node-icon">🎯</span>
          <span class="node-title">{{ goal.title }}</span>
          <span class="node-badge" :class="goal.status">{{ goal.status }}</span>
        </div>

        <div v-if="expanded[goal.id]" class="node-children">
          <!-- Ideas under this goal -->
          <div v-for="idea in filterItems(goal.ideas)" :key="idea.id" class="tree-node idea-node">
            <div class="node-header" @click="toggle(idea.id)">
              <span class="expand-icon">{{ expanded[idea.id] ? '▼' : '▶' }}</span>
              <span class="node-icon">💡</span>
              <span class="node-title">{{ idea.title }}</span>
              <span v-if="idea.conscience_verdict" class="verdict-badge" :class="idea.conscience_verdict">
                {{ idea.conscience_verdict }}
              </span>
            </div>

            <div v-if="expanded[idea.id]" class="node-children">
              <!-- Conscience reason -->
              <div v-if="idea.conscience_reason" class="node-detail">
                <span class="detail-label">⚖️ Conscience:</span>
                {{ idea.conscience_reason.substring(0, 150) }}{{ idea.conscience_reason.length > 150 ? '...' : '' }}
              </div>

              <!-- Plans under this idea -->
              <div v-for="plan in filterPlans(idea.plans)" :key="plan.id" class="tree-node plan-node">
                <div class="node-header" @click="toggle(plan.id)">
                  <span class="expand-icon">{{ expanded[plan.id] ? '▼' : '▶' }}</span>
                  <span class="node-icon">📋</span>
                  <span class="node-title">{{ plan.title }}</span>
                  <span class="node-badge" :class="plan.status">{{ plan.status }}</span>
                </div>

                <div v-if="expanded[plan.id]" class="node-children">
                  <!-- Tasks -->
                  <div v-for="task in filterTasks(plan.tasks)" :key="task.id" class="tree-node task-node">
                    <div class="node-header" @click="toggle(task.id)">
                      <span class="expand-icon" v-if="task.content">{{ expanded[task.id] ? '▼' : '▶' }}</span>
                      <span class="task-status">
                        {{ task.done ? '✅' : task.status === 'dispatched' ? '🔵' : '⬜' }}
                      </span>
                      <span class="node-title" :class="{ done: task.done }">{{ task.title }}</span>
                      <span v-if="task.assignedTo" class="task-assignee">→ {{ task.assignedTo }}</span>
                    </div>
                    <div v-if="expanded[task.id] && task.content" class="node-detail task-content">
                      {{ task.content }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Orphan ideas (no goal) -->
      <div v-if="filteredOrphans.length" class="tree-section">
        <div class="section-label">Orphan Ideas</div>
        <div v-for="idea in filteredOrphans" :key="idea.id" class="tree-node idea-node">
          <div class="node-header" @click="toggle(idea.id)">
            <span class="expand-icon">{{ expanded[idea.id] ? '▼' : '▶' }}</span>
            <span class="node-icon">💡</span>
            <span class="node-title">{{ idea.title }}</span>
            <span v-if="idea.conscience_verdict" class="verdict-badge" :class="idea.conscience_verdict">
              {{ idea.conscience_verdict }}
            </span>
          </div>

          <div v-if="expanded[idea.id]" class="node-children">
            <div v-if="idea.conscience_reason" class="node-detail">
              <span class="detail-label">⚖️ Conscience:</span>
              {{ idea.conscience_reason.substring(0, 150) }}{{ idea.conscience_reason.length > 150 ? '...' : '' }}
            </div>

            <div v-for="plan in filterPlans(idea.plans)" :key="plan.id" class="tree-node plan-node">
              <div class="node-header" @click="toggle(plan.id)">
                <span class="expand-icon">{{ expanded[plan.id] ? '▼' : '▶' }}</span>
                <span class="node-icon">📋</span>
                <span class="node-title">{{ plan.title }}</span>
                <span class="node-badge" :class="plan.status">{{ plan.status }}</span>
              </div>

              <div v-if="expanded[plan.id]" class="node-children">
                <div v-for="task in filterTasks(plan.tasks)" :key="task.id" class="tree-node task-node">
                  <div class="node-header" @click="toggle(task.id)">
                    <span class="expand-icon" v-if="task.content">{{ expanded[task.id] ? '▼' : '▶' }}</span>
                    <span class="task-status">
                      {{ task.done ? '✅' : task.status === 'dispatched' ? '🔵' : '⬜' }}
                    </span>
                    <span class="node-title" :class="{ done: task.done }">{{ task.title }}</span>
                    <span v-if="task.assignedTo" class="task-assignee">→ {{ task.assignedTo }}</span>
                  </div>
                  <div v-if="expanded[task.id] && task.content" class="node-detail task-content">
                    {{ task.content }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="filteredGoals.length === 0 && filteredOrphans.length === 0" class="empty">
        No active goals or ideas
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { SoulState, SoulIdea, SoulPlan, SoulTask, ActivityEvent } from './SoulApiClient';

const props = defineProps<{
  state: SoulState;
  activity: ActivityEvent[];
}>();

const showCompleted = ref(false);
const expanded = ref<Record<string, boolean>>({});

function toggle(id: string) {
  expanded.value[id] = !expanded.value[id];
}

const HIDDEN_STATUSES = ['done', 'superseded', 'completed', 'rejected'];

function isHidden(status: string): boolean {
  return !showCompleted.value && HIDDEN_STATUSES.includes(status);
}

function isTaskHidden(task: { done: boolean; status?: string }): boolean {
  if (showCompleted.value) return false;
  if (task.done) return true;
  return task.status ? HIDDEN_STATUSES.includes(task.status) : false;
}

const filteredGoals = computed(() => {
  return props.state.goals.filter(g => !isHidden(g.status));
});

const filteredOrphans = computed(() => {
  return (props.state.orphanIdeas ?? []).filter(i => !isHidden(i.status));
});

function filterItems(items: SoulIdea[]): SoulIdea[] {
  return items.filter(i => !isHidden(i.status));
}

function filterPlans(plans: SoulPlan[]): SoulPlan[] {
  return plans.filter(p => !isHidden(p.status));
}

function filterTasks(tasks: SoulTask[]): SoulTask[] {
  return tasks.filter(t => !isTaskHidden(t));
}
</script>

<style scoped>
.mind-map-tree {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  flex-shrink: 0;
}

.tree-header h3 {
  margin: 0;
  font-size: 14px;
  color: #e5e7eb;
}

.toggle-completed {
  font-size: 11px;
  color: #94a3b8;
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.tree-content {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
}

/* Node indentation per level */
.goal-node {
  padding-left: 0;
}

.idea-node {
  padding-left: 20px;
}

.plan-node {
  padding-left: 40px;
}

.task-node {
  padding-left: 60px;
}

.node-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 4px;
}

.node-header:hover {
  background: #1e293b;
}

.expand-icon {
  width: 16px;
  color: #6b7280;
  font-size: 10px;
  flex-shrink: 0;
  text-align: center;
}

.node-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.node-title {
  color: #e5e7eb;
  font-size: 13px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-title.done {
  text-decoration: line-through;
  color: #6b7280;
}

.node-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}

.node-badge.active {
  background: #7c3aed33;
  color: #a78bfa;
}

.node-badge.approved {
  background: #22c55e33;
  color: #22c55e;
}

.node-badge.pending {
  background: #eab30833;
  color: #eab308;
}

.node-badge.done,
.node-badge.completed {
  background: #6b728033;
  color: #6b7280;
}

.node-badge.rejected {
  background: #ef444433;
  color: #ef4444;
}

.node-badge.superseded {
  background: #6b728033;
  color: #6b7280;
}

.verdict-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}

.verdict-badge.approved {
  background: #22c55e33;
  color: #22c55e;
}

.verdict-badge.pending {
  background: #eab30833;
  color: #eab308;
}

.verdict-badge.rejected {
  background: #ef444433;
  color: #ef4444;
}

.verdict-badge.boundary {
  background: #f59e0b33;
  color: #f59e0b;
}

.verdict-badge.rework {
  background: #eab30833;
  color: #eab308;
}

.node-detail {
  font-size: 11px;
  color: #94a3b8;
  padding: 4px 8px 4px 44px;
  line-height: 1.4;
}

.detail-label {
  font-weight: 600;
}

.task-status {
  font-size: 12px;
  flex-shrink: 0;
}

.task-assignee {
  color: #9ca3af;
  font-size: 0.75rem;
  margin-left: 0.5rem;
}

.task-content {
  white-space: pre-wrap;
  padding-left: 76px;
}

.tree-section {
  margin-top: 12px;
}

.section-label {
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  padding: 4px 8px;
}

.empty {
  color: #6b7280;
  padding: 20px;
  text-align: center;
  font-size: 13px;
}
</style>
