<template>
  <div ref="containerEl" class="mindmap-container">
    <svg ref="svgEl" class="mindmap-svg">
      <defs>
        <filter id="glow-green">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="glow-blue">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g ref="rootG" class="root-group" />
    </svg>

    <!-- Dialogue panel -->
    <Transition name="panel-slide">
      <div v-if="selectedNode" class="dialogue-panel">
        <div class="dialogue-header">
          <span class="dialogue-title">{{ selectedNode.title }}</span>
          <button class="dialogue-close" @click="selectedNode = null">&times;</button>
        </div>
        <div class="dialogue-body">
          <div v-if="selectedNode.dialogue && selectedNode.dialogue.length">
            <div
              v-for="turn in selectedNode.dialogue"
              :key="turn.turn"
              class="dialogue-turn"
              :class="{ boundary: turn.boundary, verdict: turn.verdict }"
            >
              <div class="turn-meta">
                <span class="turn-agent">{{ turn.agent }}</span>
                <span v-if="turn.verdict" class="turn-verdict" :class="turn.verdict">{{ turn.verdict }}</span>
                <span v-if="turn.boundary" class="turn-boundary">{{ turn.boundary }}</span>
              </div>
              <div v-if="turn.reason" class="turn-text">{{ turn.reason }}</div>
              <div v-if="turn.argument" class="turn-text turn-argument">{{ turn.argument }}</div>
            </div>
          </div>
          <div v-else class="dialogue-empty">No dialogue history</div>
          <div v-if="selectedNode.tasks && selectedNode.tasks.length" class="tasks-section">
            <div class="tasks-title">Tasks</div>
            <div v-for="task in selectedNode.tasks" :key="task.id" class="task-item" :class="{ done: task.done }">
              <span class="task-check">{{ task.done ? '✓' : '○' }}</span>
              {{ task.title }}
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as d3 from 'd3';
import type { SoulState, ActivityEvent, DialogueTurn, SoulTask } from './SoulApiClient';

const props = defineProps<{
  state: SoulState;
  activity: ActivityEvent[];
}>();

interface TreeNode {
  id: string;
  title: string;
  status: string;
  type: 'root' | 'goal' | 'idea' | 'plan';
  dialogue?: DialogueTurn[];
  tasks?: SoulTask[];
  children?: TreeNode[];
}

interface SelectedNodeInfo {
  title: string;
  dialogue?: DialogueTurn[];
  tasks?: SoulTask[];
}

const containerEl = ref<HTMLElement | null>(null);
const svgEl = ref<SVGSVGElement | null>(null);
const rootG = ref<SVGGElement | null>(null);
const selectedNode = ref<SelectedNodeInfo | null>(null);

const STATUS_COLORS: Record<string, string> = {
  pending: '#6b7280',
  approved: '#3b82f6',
  in_progress: '#22c55e',
  done: '#22c55e',
  rejected: '#ef4444',
  boundary: '#f59e0b',
};

const TYPE_RADIUS: Record<string, number> = {
  root: 20,
  goal: 16,
  idea: 12,
  plan: 9,
};

function getColor(status: string): string {
  return STATUS_COLORS[status] || STATUS_COLORS.pending;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function buildHierarchy(state: SoulState): TreeNode {
  const root: TreeNode = {
    id: '__root__',
    title: 'Thinking',
    status: 'approved',
    type: 'root',
    children: [],
  };

  for (const goal of state.goals) {
    const goalNode: TreeNode = {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      type: 'goal',
      children: [],
    };
    for (const idea of goal.ideas) {
      const ideaNode: TreeNode = {
        id: idea.id,
        title: idea.title,
        status: idea.conscience_verdict === 'boundary' ? 'boundary' : idea.status,
        type: 'idea',
        dialogue: idea.dialogue,
        children: [],
      };
      for (const plan of idea.plans) {
        ideaNode.children!.push({
          id: plan.id,
          title: plan.title,
          status: plan.status,
          type: 'plan',
          tasks: plan.tasks,
        });
      }
      goalNode.children!.push(ideaNode);
    }
    root.children!.push(goalNode);
  }

  // Orphan ideas as direct children of root
  for (const idea of state.orphanIdeas) {
    const ideaNode: TreeNode = {
      id: idea.id,
      title: idea.title,
      status: idea.conscience_verdict === 'boundary' ? 'boundary' : idea.status,
      type: 'idea',
      dialogue: idea.dialogue,
      children: [],
    };
    for (const plan of idea.plans) {
      ideaNode.children!.push({
        id: plan.id,
        title: plan.title,
        status: plan.status,
        type: 'plan',
        tasks: plan.tasks,
      });
    }
    root.children!.push(ideaNode);
  }

  // Orphan plans as direct children of root
  for (const plan of state.orphanPlans) {
    root.children!.push({
      id: plan.id,
      title: plan.title,
      status: plan.status,
      type: 'plan',
      tasks: plan.tasks,
    });
  }

  return root;
}

function activeAgentMap(activity: ActivityEvent[]): Map<string, string[]> {
  // Map entityId -> list of agent names currently active on it
  const map = new Map<string, string[]>();
  const cutoff = Date.now() - 30_000; // last 30 seconds
  for (const ev of activity) {
    if (ev.entityId && ev.timestamp > cutoff) {
      const list = map.get(ev.entityId) || [];
      if (!list.includes(ev.agent)) list.push(ev.agent);
      map.set(ev.entityId, list);
    }
  }
  return map;
}

function render() {
  if (!svgEl.value || !rootG.value || !containerEl.value) return;

  const container = containerEl.value;
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  const svg = d3.select(svgEl.value)
    .attr('width', width)
    .attr('height', height);

  const g = d3.select(rootG.value);
  g.selectAll('*').remove();

  const hierarchy = buildHierarchy(props.state);

  // If there's nothing to render, show a placeholder
  if (!hierarchy.children || hierarchy.children.length === 0) {
    g.append('text')
      .attr('x', width / 2)
      .attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#6b7280')
      .attr('font-size', '14px')
      .text('No goals or ideas yet');
    return;
  }

  const root = d3.hierarchy(hierarchy);
  const margin = { top: 40, right: 120, bottom: 40, left: 120 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const treeLayout = d3.tree<TreeNode>()
    .size([innerHeight, innerWidth])
    .separation((a, b) => (a.parent === b.parent ? 1.2 : 2));

  treeLayout(root);

  const mainG = g.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Curved links
  const linkGenerator = d3.linkHorizontal<d3.HierarchyLink<TreeNode>, d3.HierarchyPointNode<TreeNode>>()
    .x((d: any) => d.y)
    .y((d: any) => d.x);

  mainG.selectAll('.link')
    .data(root.links())
    .join('path')
    .attr('class', 'link')
    .attr('d', linkGenerator as any)
    .attr('fill', 'none')
    .attr('stroke', (d) => {
      const targetColor = getColor(d.target.data.status);
      return targetColor;
    })
    .attr('stroke-opacity', 0.35)
    .attr('stroke-width', 1.5);

  // Agent activity map
  const agentMap = activeAgentMap(props.activity);

  // Nodes
  const nodeGroups = mainG.selectAll('.node')
    .data(root.descendants())
    .join('g')
    .attr('class', 'node')
    .attr('transform', (d) => `translate(${d.y},${d.x})`)
    .style('cursor', (d) => {
      const data = d.data;
      return (data.dialogue && data.dialogue.length) || (data.tasks && data.tasks.length) ? 'pointer' : 'default';
    })
    .on('click', (_event, d) => {
      const data = d.data;
      if ((data.dialogue && data.dialogue.length) || (data.tasks && data.tasks.length)) {
        selectedNode.value = {
          title: data.title,
          dialogue: data.dialogue,
          tasks: data.tasks,
        };
      }
    });

  // Node circles
  nodeGroups.append('circle')
    .attr('r', (d) => TYPE_RADIUS[d.data.type] || 10)
    .attr('fill', (d) => {
      const color = getColor(d.data.status);
      return d.data.status === 'done' ? color : d3.color(color)!.copy({ opacity: 0.2 }).formatRgb();
    })
    .attr('stroke', (d) => getColor(d.data.status))
    .attr('stroke-width', (d) => d.data.type === 'root' ? 3 : 2)
    .attr('filter', (d) => d.data.status === 'in_progress' ? 'url(#glow-green)' : null)
    .each(function (d) {
      if (d.data.status === 'in_progress') {
        d3.select(this).classed('pulse', true);
      }
    });

  // Labels
  nodeGroups.append('text')
    .attr('dy', (d) => {
      const r = TYPE_RADIUS[d.data.type] || 10;
      return -(r + 6);
    })
    .attr('text-anchor', 'middle')
    .attr('fill', '#d1d5db')
    .attr('font-size', (d) => d.data.type === 'root' ? '13px' : d.data.type === 'goal' ? '12px' : '11px')
    .attr('font-weight', (d) => d.data.type === 'root' || d.data.type === 'goal' ? '600' : '400')
    .text((d) => truncate(d.data.title, d.data.type === 'root' ? 20 : d.data.type === 'goal' ? 28 : 24));

  // Type badges (small text below node)
  nodeGroups.filter((d) => d.data.type !== 'root')
    .append('text')
    .attr('dy', (d) => {
      const r = TYPE_RADIUS[d.data.type] || 10;
      return r + 14;
    })
    .attr('text-anchor', 'middle')
    .attr('fill', '#4b5563')
    .attr('font-size', '9px')
    .attr('text-transform', 'uppercase')
    .text((d) => d.data.type);

  // Agent indicators
  nodeGroups.each(function (d) {
    const agents = agentMap.get(d.data.id);
    if (!agents || agents.length === 0) return;
    const group = d3.select(this);
    const r = TYPE_RADIUS[d.data.type] || 10;

    agents.forEach((agent, i) => {
      const angle = (-Math.PI / 4) + (i * Math.PI / 6);
      const dist = r + 12;
      const ax = Math.cos(angle) * dist;
      const ay = Math.sin(angle) * dist;

      const agentG = group.append('g')
        .attr('transform', `translate(${ax},${ay})`);

      agentG.append('circle')
        .attr('r', 6)
        .attr('fill', '#7c3aed')
        .attr('stroke', '#1f2937')
        .attr('stroke-width', 1.5)
        .classed('agent-pulse', true);

      agentG.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em')
        .attr('fill', '#fff')
        .attr('font-size', '7px')
        .attr('font-weight', '700')
        .text(agent.charAt(0).toUpperCase());
    });
  });

  // Zoom & pan
  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 3])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });

  svg.call(zoom);

  // Auto-fit: compute bounds and center
  const bounds = (mainG.node() as SVGGElement)?.getBBox();
  if (bounds) {
    const fullWidth = bounds.width + margin.left + margin.right;
    const fullHeight = bounds.height + margin.top + margin.bottom;
    const scale = Math.min(
      width / fullWidth,
      height / fullHeight,
      1.2
    );
    const tx = (width - fullWidth * scale) / 2;
    const ty = (height - fullHeight * scale) / 2;
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }
}

// Resize observer
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  nextTick(() => render());

  if (containerEl.value) {
    resizeObserver = new ResizeObserver(() => render());
    resizeObserver.observe(containerEl.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
});

watch(() => props.state, () => render(), { deep: true });
watch(() => props.activity, () => render(), { deep: true });
</script>

<style scoped>
.mindmap-container {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 300px;
  overflow: hidden;
}

.mindmap-svg {
  display: block;
  width: 100%;
  height: 100%;
}

/* Pulse animation for in_progress nodes */
.mindmap-svg :deep(.pulse) {
  animation: node-pulse 2s ease-in-out infinite;
}

.mindmap-svg :deep(.agent-pulse) {
  animation: agent-glow 1.5s ease-in-out infinite alternate;
}

@keyframes node-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes agent-glow {
  0% { filter: brightness(1); }
  100% { filter: brightness(1.5); }
}

/* Dialogue panel */
.dialogue-panel {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 320px;
  max-height: calc(100% - 16px);
  background: #1f2937;
  border: 1px solid #374151;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  z-index: 10;
}

.dialogue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid #374151;
  flex-shrink: 0;
}

.dialogue-title {
  font-size: 13px;
  font-weight: 600;
  color: #e5e7eb;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialogue-close {
  background: none;
  border: none;
  color: #9ca3af;
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.dialogue-close:hover {
  color: #f3f4f6;
}

.dialogue-body {
  overflow-y: auto;
  padding: 10px 12px;
  flex: 1;
}

.dialogue-turn {
  margin-bottom: 10px;
  padding: 8px;
  border-radius: 6px;
  background: #111827;
  border-left: 3px solid #4b5563;
}

.dialogue-turn.boundary {
  border-left-color: #f59e0b;
}

.dialogue-turn.verdict {
  border-left-color: #3b82f6;
}

.turn-meta {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}

.turn-agent {
  font-size: 11px;
  font-weight: 600;
  color: #9ca3af;
}

.turn-verdict {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
}

.turn-verdict.approved {
  background: rgba(34, 197, 94, 0.2);
  color: #22c55e;
}

.turn-verdict.rejected {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.turn-verdict.rework {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
}

.turn-boundary {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.turn-text {
  font-size: 12px;
  color: #d1d5db;
  line-height: 1.4;
}

.turn-argument {
  font-style: italic;
  color: #9ca3af;
  margin-top: 2px;
}

.dialogue-empty {
  color: #6b7280;
  font-size: 12px;
  text-align: center;
  padding: 20px 0;
}

.tasks-section {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #374151;
}

.tasks-title {
  font-size: 11px;
  font-weight: 600;
  color: #9ca3af;
  margin-bottom: 6px;
  text-transform: uppercase;
}

.task-item {
  font-size: 12px;
  color: #d1d5db;
  padding: 3px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.task-item.done {
  color: #22c55e;
  text-decoration: line-through;
  opacity: 0.7;
}

.task-check {
  font-size: 11px;
  width: 14px;
  flex-shrink: 0;
}

/* Transition */
.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(20px);
  opacity: 0;
}
</style>
