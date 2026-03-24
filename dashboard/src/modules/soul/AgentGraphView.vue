<template>
  <div ref="containerEl" class="agent-graph-container">
    <svg ref="svgEl" class="agent-graph-svg">
      <defs>
        <!-- Gradient for nodes -->
        <radialGradient id="node-gradient-active" cx="40%" cy="35%">
          <stop offset="0%" stop-color="#a78bfa" />
          <stop offset="100%" stop-color="#4c1d95" />
        </radialGradient>
        <radialGradient id="node-gradient-idle" cx="40%" cy="35%">
          <stop offset="0%" stop-color="#4b5563" />
          <stop offset="100%" stop-color="#1f2937" />
        </radialGradient>
        <!-- Glow filter for active nodes -->
        <filter id="agent-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <!-- Arrow marker for edges -->
        <marker id="arrow" viewBox="0 -4 8 8" refX="8" refY="0"
                markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,-3L8,0L0,3" fill="#6b7280" opacity="0.6" />
        </marker>
      </defs>
      <g ref="rootG" class="root-group" />
    </svg>

    <!-- Agent detail panel -->
    <Transition name="panel-slide">
      <div v-if="selectedAgent" class="agent-detail-panel">
        <div class="detail-header">
          <span class="detail-icon">{{ selectedAgent.icon }}</span>
          <span class="detail-name">{{ selectedAgent.label }}</span>
          <span class="detail-status" :class="selectedAgent.active ? 'active' : 'idle'">
            {{ selectedAgent.active ? 'Active' : 'Idle' }}
          </span>
          <button class="detail-close" @click="selectedAgent = null">&times;</button>
        </div>
        <div class="detail-body">
          <div v-if="selectedAgent.currentActivity" class="detail-section">
            <div class="detail-section-title">Currently working on</div>
            <div class="detail-current">
              <div class="detail-current-summary">{{ selectedAgent.currentActivity.summary }}</div>
              <div v-if="selectedAgent.currentActivity.entityId" class="detail-current-entity">
                {{ selectedAgent.currentActivity.entityId }}
              </div>
            </div>
          </div>
          <div v-else class="detail-section">
            <div class="detail-section-title">Currently working on</div>
            <div class="detail-empty">No current activity</div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">Recent activity</div>
            <div v-if="selectedAgent.recentEvents.length" class="detail-events">
              <div v-for="ev in selectedAgent.recentEvents" :key="ev.timestamp + ev.summary" class="detail-event">
                <div class="detail-event-time">{{ formatTime(ev.timestamp) }}</div>
                <div class="detail-event-summary">{{ ev.summary }}</div>
                <div v-if="ev.entityId" class="detail-event-entity">{{ ev.entityId }}</div>
              </div>
            </div>
            <div v-else class="detail-empty">No recent events</div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as d3 from 'd3';
import type { ActivityEvent } from './SoulApiClient';

const props = defineProps<{
  activity: ActivityEvent[];
}>();

// --- Types ---

interface AgentNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  icon: string;
  known: boolean;
  activityCount: number;
  lastActive: number;
}

interface AgentEdge extends d3.SimulationLinkDatum<AgentNode> {
  sourceId: string;
  targetId: string;
  count: number;
  lastTimestamp: number;
  lastSummary: string;
  lastType: string;
}

interface Particle {
  id: number;
  edgeKey: string;
  progress: number;
  color: string;
  birth: number;
}

// --- Constants ---

const KNOWN_AGENTS: { id: string; label: string; icon: string }[] = [
  { id: 'chat-agent', label: 'Chat Agent', icon: '\uD83D\uDCAC' },
  { id: 'consciousness', label: 'Consciousness', icon: '\uD83E\uDDE0' },
  { id: 'conscience', label: 'Conscience', icon: '\u2696\uFE0F' },
  { id: 'strategist', label: 'Strategist', icon: '\uD83D\uDCD0' },
  { id: 'foreman', label: 'Foreman', icon: '\uD83D\uDD27' },
];

const KNOWN_MAP = new Map(KNOWN_AGENTS.map((a) => [a.id, a]));

const EVENT_COLORS: Record<string, string> = {
  idea: '#a855f7',      // purple
  plan: '#3b82f6',      // blue
  dialogue: '#f97316',  // orange
  action: '#22c55e',    // green
  user: '#06b6d4',      // cyan
  goal: '#eab308',      // yellow
};

const ACTIVITY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVE_THRESHOLD_MS = 30_000;        // 30 seconds
const PARTICLE_DURATION_MS = 2000;

// --- Detail panel types ---

interface SelectedAgentInfo {
  id: string;
  label: string;
  icon: string;
  active: boolean;
  currentActivity: ActivityEvent | null;
  recentEvents: ActivityEvent[];
}

// --- Refs ---

const containerEl = ref<HTMLElement | null>(null);
const svgEl = ref<SVGSVGElement | null>(null);
const rootG = ref<SVGGElement | null>(null);
const selectedAgent = ref<SelectedAgentInfo | null>(null);

// --- State ---

let nodes: AgentNode[] = [];
let edges: AgentEdge[] = [];
let particles: Particle[] = [];
let particleIdCounter = 0;
let simulation: d3.Simulation<AgentNode, AgentEdge> | null = null;
let animationFrame: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let width = 800;
let height = 600;

// D3 selections (stored for updates without full re-render)
let svgSelection: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
let gSelection: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
let edgeGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
let nodeGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
let particleGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;

// --- Helpers ---

function getParticleColor(type: string): string {
  return EVENT_COLORS[type] || EVENT_COLORS.action;
}

function edgeKey(from: string, to: string): string {
  return `${from}→${to}`;
}

function getOrCreateNode(id: string): AgentNode {
  let node = nodes.find((n) => n.id === id);
  if (!node) {
    const known = KNOWN_MAP.get(id);
    node = {
      id,
      label: known?.label || id,
      icon: known?.icon || '\uD83E\uDD16',
      known: !!known,
      activityCount: 0,
      lastActive: 0,
    };
    nodes.push(node);
  }
  return node;
}

function getOrCreateEdge(from: string, to: string): AgentEdge {
  const key = edgeKey(from, to);
  let edge = edges.find((e) => e.sourceId === from && e.targetId === to);
  if (!edge) {
    const sourceNode = getOrCreateNode(from);
    const targetNode = getOrCreateNode(to);
    edge = {
      source: sourceNode,
      target: targetNode,
      sourceId: from,
      targetId: to,
      count: 0,
      lastTimestamp: 0,
      lastSummary: '',
      lastType: '',
    };
    edges.push(edge);
  }
  return edge;
}

function nodeRadius(node: AgentNode): number {
  const base = 30;
  const extra = Math.min(node.activityCount * 0.5, 10);
  return base + extra;
}

function isActive(node: AgentNode): boolean {
  return Date.now() - node.lastActive < ACTIVE_THRESHOLD_MS;
}

function edgeOpacity(edge: AgentEdge): number {
  const age = Date.now() - edge.lastTimestamp;
  if (age < 10_000) return 0.8;
  if (age < 60_000) return 0.5;
  if (age < ACTIVITY_WINDOW_MS) return 0.25;
  return 0.1;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
}

// Compute a curved path between two points
function edgePath(sx: number, sy: number, tx: number, ty: number): string {
  const dx = tx - sx;
  const dy = ty - sy;
  const dr = Math.sqrt(dx * dx + dy * dy) * 0.6;
  return `M${sx},${sy}A${dr},${dr} 0 0,1 ${tx},${ty}`;
}

// Get point along the edge path at parameter t (0..1)
function pointOnEdge(sx: number, sy: number, tx: number, ty: number, t: number): { x: number; y: number } {
  // Simple quadratic bezier approximation for the arc
  const dx = tx - sx;
  const dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const offset = dist * 0.15; // perpendicular offset for curve
  const mx = (sx + tx) / 2 - (dy / dist) * offset;
  const my = (sy + ty) / 2 + (dx / dist) * offset;
  // Quadratic bezier: P = (1-t)^2*S + 2(1-t)t*M + t^2*T
  const u = 1 - t;
  return {
    x: u * u * sx + 2 * u * t * mx + t * t * tx,
    y: u * u * sy + 2 * u * t * my + t * t * ty,
  };
}

// --- Build graph from activity events ---

function rebuildGraph() {
  const now = Date.now();
  const cutoff = now - ACTIVITY_WINDOW_MS;

  // Reset counts
  nodes.forEach((n) => { n.activityCount = 0; });

  // Always ensure known agents exist
  KNOWN_AGENTS.forEach((ka) => getOrCreateNode(ka.id));

  // Process activity
  const recentActivity = props.activity.filter((ev) => ev.timestamp > cutoff);

  for (const ev of recentActivity) {
    // Update source agent
    const agentNode = getOrCreateNode(ev.agent);
    agentNode.activityCount++;
    agentNode.lastActive = Math.max(agentNode.lastActive, ev.timestamp);

    // Update from/to nodes and edges
    if (ev.from) {
      const fromNode = getOrCreateNode(ev.from);
      fromNode.activityCount++;
      fromNode.lastActive = Math.max(fromNode.lastActive, ev.timestamp);
    }
    if (ev.to) {
      const toNode = getOrCreateNode(ev.to);
      toNode.activityCount++;
      toNode.lastActive = Math.max(toNode.lastActive, ev.timestamp);
    }

    if (ev.from && ev.to) {
      const edge = getOrCreateEdge(ev.from, ev.to);
      edge.count++;
      if (ev.timestamp > edge.lastTimestamp) {
        edge.lastTimestamp = ev.timestamp;
        edge.lastSummary = ev.summary;
        edge.lastType = ev.subtype || ev.type;
      }
    }
  }

  // Prune stale edges (older than activity window)
  edges = edges.filter((e) => e.lastTimestamp > cutoff);
}

// --- Spawn particle for a new event ---

function spawnParticle(ev: ActivityEvent) {
  if (!ev.from || !ev.to) return;
  const key = edgeKey(ev.from, ev.to);
  if (!edges.find((e) => e.sourceId === ev.from && e.targetId === ev.to)) return;
  particles.push({
    id: ++particleIdCounter,
    edgeKey: key,
    progress: 0,
    color: getParticleColor(ev.subtype || ev.type),
    birth: Date.now(),
  });
}

// --- Detail panel helpers ---

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function selectAgent(agentId: string) {
  const node = nodes.find((n) => n.id === agentId);
  if (!node) return;

  const agentEvents = props.activity
    .filter((ev) => ev.agent === agentId || ev.from === agentId)
    .sort((a, b) => b.timestamp - a.timestamp);

  const current = agentEvents.length > 0 && (Date.now() - agentEvents[0].timestamp < ACTIVE_THRESHOLD_MS)
    ? agentEvents[0]
    : null;

  selectedAgent.value = {
    id: node.id,
    label: node.label,
    icon: node.icon,
    active: isActive(node),
    currentActivity: current,
    recentEvents: agentEvents.slice(0, 10),
  };
}

// --- Rendering ---

function initSvg() {
  if (!svgEl.value || !rootG.value || !containerEl.value) return;

  width = containerEl.value.clientWidth || 800;
  height = containerEl.value.clientHeight || 600;

  svgSelection = d3.select(svgEl.value)
    .attr('width', width)
    .attr('height', height);

  gSelection = d3.select(rootG.value);
  gSelection.selectAll('*').remove();

  // Layer order: edges -> particles -> nodes (nodes on top)
  edgeGroup = gSelection.append('g').attr('class', 'edges');
  particleGroup = gSelection.append('g').attr('class', 'particles');
  nodeGroup = gSelection.append('g').attr('class', 'nodes');

  // Zoom & pan
  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 3])
    .on('zoom', (event) => {
      gSelection!.attr('transform', event.transform);
    });

  svgSelection.call(zoom);
}

function setupSimulation() {
  simulation = d3.forceSimulation<AgentNode, AgentEdge>(nodes)
    .force('link', d3.forceLink<AgentNode, AgentEdge>(edges).id((d) => d.id).distance(160).strength(0.4))
    .force('charge', d3.forceManyBody().strength(-400))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide<AgentNode>().radius((d) => nodeRadius(d) + 10))
    .force('x', d3.forceX(width / 2).strength(0.05))
    .force('y', d3.forceY(height / 2).strength(0.05))
    .alphaDecay(0.02)
    .on('tick', renderTick);
}

function updateSimulation() {
  if (!simulation) {
    setupSimulation();
    return;
  }

  simulation.nodes(nodes);
  const linkForce = simulation.force<d3.ForceLink<AgentNode, AgentEdge>>('link');
  if (linkForce) {
    linkForce.links(edges);
  }
  simulation.force('center', d3.forceCenter(width / 2, height / 2));
  simulation.alpha(0.3).restart();
}

function renderTick() {
  if (!edgeGroup || !nodeGroup || !particleGroup) return;

  const now = Date.now();

  // --- Edges ---
  const edgeSel = edgeGroup.selectAll<SVGGElement, AgentEdge>('.edge-group')
    .data(edges, (d) => edgeKey(d.sourceId, d.targetId));

  const edgeEnter = edgeSel.enter().append('g').attr('class', 'edge-group');
  edgeEnter.append('path').attr('class', 'edge-path');
  edgeEnter.append('text').attr('class', 'edge-label');

  const edgeMerged = edgeEnter.merge(edgeSel);

  edgeMerged.select('.edge-path')
    .attr('d', (d) => {
      const s = d.source as AgentNode;
      const t = d.target as AgentNode;
      return edgePath(s.x || 0, s.y || 0, t.x || 0, t.y || 0);
    })
    .attr('fill', 'none')
    .attr('stroke', '#6b7280')
    .attr('stroke-width', (d) => Math.min(1 + d.count * 0.2, 3))
    .attr('stroke-opacity', (d) => edgeOpacity(d))
    .attr('marker-end', 'url(#arrow)');

  edgeMerged.select('.edge-label')
    .attr('x', (d) => {
      const s = d.source as AgentNode;
      const t = d.target as AgentNode;
      const pt = pointOnEdge(s.x || 0, s.y || 0, t.x || 0, t.y || 0, 0.5);
      return pt.x;
    })
    .attr('y', (d) => {
      const s = d.source as AgentNode;
      const t = d.target as AgentNode;
      const pt = pointOnEdge(s.x || 0, s.y || 0, t.x || 0, t.y || 0, 0.5);
      return pt.y - 8;
    })
    .attr('text-anchor', 'middle')
    .attr('fill', '#9ca3af')
    .attr('font-size', '9px')
    .attr('opacity', (d) => edgeOpacity(d) * 0.8)
    .text((d) => truncate(d.lastSummary, 30));

  edgeSel.exit().remove();

  // --- Nodes ---
  const nodeSel = nodeGroup.selectAll<SVGGElement, AgentNode>('.agent-node')
    .data(nodes, (d) => d.id);

  const nodeEnter = nodeSel.enter().append('g').attr('class', 'agent-node');

  // Activity ring (pulse outward)
  nodeEnter.append('circle')
    .attr('class', 'activity-ring')
    .attr('r', (d) => nodeRadius(d))
    .attr('fill', 'none')
    .attr('stroke', '#7c3aed')
    .attr('stroke-width', 2)
    .attr('opacity', 0);

  // Main circle
  nodeEnter.append('circle')
    .attr('class', 'node-circle')
    .attr('stroke-width', 2);

  // Status indicator dot
  nodeEnter.append('circle')
    .attr('class', 'status-dot')
    .attr('r', 5)
    .attr('stroke', '#111827')
    .attr('stroke-width', 1.5);

  // Icon text (emoji)
  nodeEnter.append('text')
    .attr('class', 'node-icon')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('pointer-events', 'none');

  // Label text
  nodeEnter.append('text')
    .attr('class', 'node-label')
    .attr('text-anchor', 'middle')
    .attr('fill', '#d1d5db')
    .attr('font-size', '11px')
    .attr('font-weight', '500')
    .attr('pointer-events', 'none');

  // Click handler for detail panel
  nodeEnter.on('click', (_event, d) => {
    selectAgent(d.id);
  });

  // Drag behavior
  nodeEnter.call(
    d3.drag<SVGGElement, AgentNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation?.alphaTarget(0.2).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation?.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      })
  );

  const nodeMerged = nodeEnter.merge(nodeSel);

  nodeMerged.attr('transform', (d) => `translate(${d.x || 0},${d.y || 0})`);

  nodeMerged.select('.node-circle')
    .attr('r', (d) => nodeRadius(d))
    .attr('fill', (d) => isActive(d) ? 'url(#node-gradient-active)' : 'url(#node-gradient-idle)')
    .attr('stroke', (d) => isActive(d) ? '#a78bfa' : '#4b5563')
    .attr('filter', (d) => isActive(d) ? 'url(#agent-glow)' : null);

  nodeMerged.select('.status-dot')
    .attr('cx', (d) => nodeRadius(d) * 0.7)
    .attr('cy', (d) => -nodeRadius(d) * 0.7)
    .attr('fill', (d) => isActive(d) ? '#22c55e' : '#6b7280');

  nodeMerged.select('.node-icon')
    .attr('font-size', (d) => `${nodeRadius(d) * 0.8}px`)
    .text((d) => d.icon);

  nodeMerged.select('.node-label')
    .attr('y', (d) => nodeRadius(d) + 16)
    .text((d) => d.label);

  // Pulse active ring
  nodeMerged.select('.activity-ring')
    .attr('r', (d) => nodeRadius(d))
    .attr('stroke', (d) => isActive(d) ? '#7c3aed' : 'none')
    .attr('opacity', (d) => isActive(d) ? 0.4 + 0.3 * Math.sin(now / 600) : 0)
    .attr('stroke-width', (d) => isActive(d) ? 2 + Math.sin(now / 600) : 0);

  nodeSel.exit().remove();

  // --- Particles ---
  // Advance particles
  particles = particles.filter((p) => {
    const age = now - p.birth;
    p.progress = age / PARTICLE_DURATION_MS;
    return p.progress < 1;
  });

  const particleSel = particleGroup.selectAll<SVGCircleElement, Particle>('.particle')
    .data(particles, (d) => d.id);

  particleSel.enter()
    .append('circle')
    .attr('class', 'particle')
    .attr('r', 4)
    .attr('opacity', 0.9)
    .merge(particleSel)
    .attr('fill', (d) => d.color)
    .attr('opacity', (d) => 1 - d.progress * 0.5)
    .attr('r', (d) => 3 + (1 - d.progress) * 2)
    .each(function (d) {
      const edge = edges.find((e) => edgeKey(e.sourceId, e.targetId) === d.edgeKey);
      if (!edge) {
        d3.select(this).attr('opacity', 0);
        return;
      }
      const s = edge.source as AgentNode;
      const t = edge.target as AgentNode;
      const pt = pointOnEdge(s.x || 0, s.y || 0, t.x || 0, t.y || 0, d.progress);
      d3.select(this).attr('cx', pt.x).attr('cy', pt.y);
    });

  particleSel.exit().remove();
}

function startAnimationLoop() {
  function loop() {
    renderTick();
    animationFrame = requestAnimationFrame(loop);
  }
  animationFrame = requestAnimationFrame(loop);
}

function stopAnimationLoop() {
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
}

function handleResize() {
  if (!containerEl.value || !svgSelection) return;
  width = containerEl.value.clientWidth || 800;
  height = containerEl.value.clientHeight || 600;
  svgSelection.attr('width', width).attr('height', height);
  if (simulation) {
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    simulation.force('x', d3.forceX(width / 2).strength(0.05));
    simulation.force('y', d3.forceY(height / 2).strength(0.05));
    simulation.alpha(0.3).restart();
  }
}

// --- Lifecycle ---

let prevActivityLength = 0;

watch(
  () => props.activity,
  (newActivity) => {
    // Detect new events (appended to the end)
    const newEvents = newActivity.slice(prevActivityLength);
    prevActivityLength = newActivity.length;

    rebuildGraph();
    updateSimulation();

    // Spawn particles for new events
    for (const ev of newEvents) {
      spawnParticle(ev);
    }
  },
  { deep: true }
);

onMounted(() => {
  nextTick(() => {
    initSvg();
    rebuildGraph();
    setupSimulation();
    startAnimationLoop();

    if (containerEl.value) {
      resizeObserver = new ResizeObserver(() => handleResize());
      resizeObserver.observe(containerEl.value);
    }
  });
});

onUnmounted(() => {
  stopAnimationLoop();
  simulation?.stop();
  resizeObserver?.disconnect();
});
</script>

<style scoped>
.agent-graph-container {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 300px;
  overflow: hidden;
  background: transparent;
}

.agent-graph-svg {
  display: block;
  width: 100%;
  height: 100%;
}

/* Pulse animation for activity rings */
.agent-graph-svg :deep(.activity-ring) {
  transition: opacity 0.3s ease;
}

/* Particle glow */
.agent-graph-svg :deep(.particle) {
  filter: drop-shadow(0 0 3px currentColor);
}

/* Edge hover */
.agent-graph-svg :deep(.edge-path) {
  transition: stroke-opacity 0.2s ease;
}

/* Node cursor */
.agent-graph-svg :deep(.agent-node) {
  cursor: pointer;
}

.agent-graph-svg :deep(.agent-node:active) {
  cursor: grabbing;
}

/* Agent detail panel */
.agent-detail-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 300px;
  height: 100%;
  background: #1e293b;
  border-left: 1px solid #4b5563;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
  z-index: 10;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #4b5563;
  flex-shrink: 0;
}

.detail-icon {
  font-size: 20px;
}

.detail-name {
  font-size: 14px;
  font-weight: 600;
  color: #e5e7eb;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-status {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 600;
  text-transform: uppercase;
  flex-shrink: 0;
}

.detail-status.active {
  background: rgba(34, 197, 94, 0.2);
  color: #22c55e;
}

.detail-status.idle {
  background: rgba(107, 114, 128, 0.2);
  color: #9ca3af;
}

.detail-close {
  background: none;
  border: none;
  color: #9ca3af;
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  flex-shrink: 0;
}

.detail-close:hover {
  color: #f3f4f6;
}

.detail-body {
  overflow-y: auto;
  padding: 12px 14px;
  flex: 1;
}

.detail-section {
  margin-bottom: 16px;
}

.detail-section-title {
  font-size: 11px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.detail-current {
  padding: 8px 10px;
  background: #111827;
  border-radius: 6px;
  border-left: 3px solid #7c3aed;
}

.detail-current-summary {
  font-size: 12px;
  color: #d1d5db;
  line-height: 1.4;
}

.detail-current-entity {
  font-size: 10px;
  color: #6b7280;
  margin-top: 4px;
  font-family: monospace;
}

.detail-empty {
  color: #6b7280;
  font-size: 12px;
  padding: 8px 0;
}

.detail-events {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-event {
  padding: 6px 10px;
  background: #111827;
  border-radius: 6px;
  border-left: 3px solid #4b5563;
}

.detail-event-time {
  font-size: 10px;
  color: #6b7280;
  margin-bottom: 2px;
  font-family: monospace;
}

.detail-event-summary {
  font-size: 12px;
  color: #d1d5db;
  line-height: 1.3;
}

.detail-event-entity {
  font-size: 10px;
  color: #6b7280;
  margin-top: 2px;
  font-family: monospace;
}

/* Panel slide transition */
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
