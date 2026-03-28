<template>
  <div ref="containerEl" class="agent-graph-container">
    <svg ref="svgEl" class="agent-graph-svg">
      <defs>
        <radialGradient id="node-gradient-active" cx="40%" cy="35%">
          <stop offset="0%" stop-color="#a78bfa" />
          <stop offset="100%" stop-color="#4c1d95" />
        </radialGradient>
        <radialGradient id="node-gradient-idle" cx="40%" cy="35%">
          <stop offset="0%" stop-color="#4b5563" />
          <stop offset="100%" stop-color="#1f2937" />
        </radialGradient>
        <filter id="agent-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <marker id="arrow" viewBox="0 -4 8 8" refX="8" refY="0"
                markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,-3L8,0L0,3" fill="#6b7280" opacity="0.6" />
        </marker>
      </defs>
      <g ref="rootG" class="root-group" />
    </svg>

  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as d3 from 'd3';
import type { ActivityEvent, AgentTopology, AgentTopologyEdge } from './SoulApiClient';
import { fetchAgentTopology } from './SoulApiClient';

const props = defineProps<{
  activity: ActivityEvent[];
}>();

const emit = defineEmits<{
  'select-agent': [agentId: string];
}>();

// --- Types ---

interface AgentNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  icon: string;
  description: string;
  apiStatus: string;
  activityCount: number;
  lastActive: number;
}

interface AgentEdge extends d3.SimulationLinkDatum<AgentNode> {
  sourceId: string;
  targetId: string;
  port: string;
  subject: string;
  messageCount: number;
  lastTimestamp: number;
  lastType: string;
}

interface Particle {
  id: number;
  edgeKey: string;
  progress: number;
  color: string;
  birth: number;
}

// Detail panel types removed — now in AgentDetailPanel.vue

// --- Constants ---

const DEFAULT_ICON = '🤖';

const EVENT_COLORS: Record<string, string> = {
  idea: '#a855f7',
  plan: '#3b82f6',
  dialogue: '#f97316',
  action: '#22c55e',
  user: '#06b6d4',
  goal: '#eab308',
};

const ACTIVE_THRESHOLD_MS = 30_000;
const PARTICLE_DURATION_MS = 2000;
const TOPOLOGY_POLL_MS = 10_000;

// --- Refs ---

const containerEl = ref<HTMLElement | null>(null);
const svgEl = ref<SVGSVGElement | null>(null);
const rootG = ref<SVGGElement | null>(null);
// selectedAgent removed — parent handles via emit

// --- State ---

let nodes: AgentNode[] = [];
let edges: AgentEdge[] = [];
let particles: Particle[] = [];
let particleIdCounter = 0;
let simulation: d3.Simulation<AgentNode, AgentEdge> | null = null;
let animationFrame: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let topologyInterval: ReturnType<typeof setInterval> | null = null;
let width = 800;
let height = 600;

let svgSelection: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
let gSelection: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
let edgeGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
let nodeGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
let particleGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;

// --- Helpers ---

function edgeKey(from: string, to: string): string {
  return `${from}→${to}`;
}

function nodeRadius(node: AgentNode): number {
  const base = 28;
  const extra = Math.min(node.activityCount * 0.8, 14);
  return base + extra;
}

function isActive(node: AgentNode): boolean {
  return node.apiStatus === 'running' && Date.now() - node.lastActive < ACTIVE_THRESHOLD_MS;
}

function isBusy(node: AgentNode): boolean {
  return Date.now() - node.lastActive < ACTIVE_THRESHOLD_MS;
}

function edgeWidth(edge: AgentEdge): number {
  if (edge.messageCount === 0) return 1;
  return Math.min(1 + Math.log2(edge.messageCount + 1) * 1.5, 6);
}

function edgeOpacity(edge: AgentEdge): number {
  if (edge.messageCount === 0) return 0.15; // static topology edge, no messages yet
  const age = Date.now() - edge.lastTimestamp;
  if (age < 10_000) return 0.9;
  if (age < 60_000) return 0.6;
  if (age < 300_000) return 0.35;
  return 0.2;
}

function edgeColor(edge: AgentEdge): string {
  if (edge.messageCount === 0) return '#4b5563';
  const age = Date.now() - edge.lastTimestamp;
  if (age < 30_000) return '#a78bfa'; // recent = purple
  return '#6b7280';
}

function edgePath(sx: number, sy: number, tx: number, ty: number): string {
  const dx = tx - sx;
  const dy = ty - sy;
  const dr = Math.sqrt(dx * dx + dy * dy) * 0.6;
  return `M${sx},${sy}A${dr},${dr} 0 0,1 ${tx},${ty}`;
}

function pointOnEdge(sx: number, sy: number, tx: number, ty: number, t: number): { x: number; y: number } {
  const dx = tx - sx;
  const dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const offset = dist * 0.15;
  const mx = (sx + tx) / 2 - (dy / dist) * offset;
  const my = (sy + ty) / 2 + (dx / dist) * offset;
  const u = 1 - t;
  return {
    x: u * u * sx + 2 * u * t * mx + t * t * tx,
    y: u * u * sy + 2 * u * t * my + t * t * ty,
  };
}

function getParticleColor(type: string): string {
  return EVENT_COLORS[type] || EVENT_COLORS.action;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// --- Topology loading ---

async function loadTopology() {
  const topology = await fetchAgentTopology();

  // Sync nodes from API
  const apiIds = new Set(topology.agents.map(a => a.id));

  // Add new agents
  for (const agent of topology.agents) {
    let node = nodes.find(n => n.id === agent.id);
    if (!node) {
      node = {
        id: agent.id,
        name: agent.name,
        icon: agent.icon || DEFAULT_ICON,
        description: agent.description,
        apiStatus: agent.status,
        activityCount: 0,
        lastActive: 0,
      };
      nodes.push(node);
    } else {
      node.name = agent.name;
      node.icon = agent.icon || DEFAULT_ICON;
      node.description = agent.description;
      node.apiStatus = agent.status;
    }
  }

  // Remove agents no longer in API
  nodes = nodes.filter(n => apiIds.has(n.id));

  // Sync static edges from topology
  for (const te of topology.edges) {
    let edge = edges.find(e => e.sourceId === te.from && e.targetId === te.to && e.port === te.port);
    if (!edge) {
      const sourceNode = nodes.find(n => n.id === te.from);
      const targetNode = nodes.find(n => n.id === te.to);
      if (sourceNode && targetNode) {
        edge = {
          source: sourceNode,
          target: targetNode,
          sourceId: te.from,
          targetId: te.to,
          port: te.port,
          subject: te.subject,
          messageCount: 0,
          lastTimestamp: 0,
          lastType: '',
        };
        edges.push(edge);
      }
    }
  }

  // Remove edges whose agents no longer exist
  edges = edges.filter(e => apiIds.has(e.sourceId) && apiIds.has(e.targetId));

  updateSimulation();
}

// --- Activity processing ---

function processActivity() {
  const now = Date.now();
  const cutoff = now - 5 * 60 * 1000;

  // Reset activity counts
  nodes.forEach(n => { n.activityCount = 0; });

  // Count per-edge message volume
  const edgeMessageCounts = new Map<string, number>();

  for (const ev of props.activity) {
    if (ev.timestamp < cutoff) continue;

    const agentNode = nodes.find(n => n.id === ev.agent);
    if (agentNode) {
      agentNode.activityCount++;
      agentNode.lastActive = Math.max(agentNode.lastActive, ev.timestamp);
    }

    if (ev.from && ev.to) {
      const key = edgeKey(ev.from, ev.to);
      edgeMessageCounts.set(key, (edgeMessageCounts.get(key) ?? 0) + 1);

      // Update edge timestamp
      const edge = edges.find(e => e.sourceId === ev.from && e.targetId === ev.to);
      if (edge) {
        edge.lastTimestamp = Math.max(edge.lastTimestamp, ev.timestamp);
        edge.lastType = ev.subtype || ev.type;
      }
    }
  }

  // Apply message counts to edges
  for (const edge of edges) {
    const key = edgeKey(edge.sourceId, edge.targetId);
    edge.messageCount = edgeMessageCounts.get(key) ?? edge.messageCount;
  }
}

// --- Particle spawning ---

function spawnParticle(ev: ActivityEvent) {
  if (!ev.from || !ev.to) return;
  const key = edgeKey(ev.from, ev.to);
  if (!edges.find(e => e.sourceId === ev.from && e.targetId === ev.to)) return;
  particles.push({
    id: ++particleIdCounter,
    edgeKey: key,
    progress: 0,
    color: getParticleColor(ev.subtype || ev.type),
    birth: Date.now(),
  });
}

// --- Agent selection (emits to parent) ---

function selectAgent(agentId: string) {
  emit('select-agent', agentId);
}

// --- Rendering ---

function initSvg() {
  if (!svgEl.value || !rootG.value || !containerEl.value) return;

  width = containerEl.value.clientWidth || 800;
  height = containerEl.value.clientHeight || 600;

  svgSelection = d3.select(svgEl.value).attr('width', width).attr('height', height);
  gSelection = d3.select(rootG.value);
  gSelection.selectAll('*').remove();

  edgeGroup = gSelection.append('g').attr('class', 'edges');
  particleGroup = gSelection.append('g').attr('class', 'particles');
  nodeGroup = gSelection.append('g').attr('class', 'nodes');

  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 3])
    .on('zoom', (event) => { gSelection!.attr('transform', event.transform); });

  svgSelection.call(zoom);
}

function setupSimulation() {
  simulation = d3.forceSimulation<AgentNode, AgentEdge>(nodes)
    .force('link', d3.forceLink<AgentNode, AgentEdge>(edges).id(d => d.id).distance(180).strength(0.3))
    .force('charge', d3.forceManyBody().strength(-500))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide<AgentNode>().radius(d => nodeRadius(d) + 15))
    .force('x', d3.forceX(width / 2).strength(0.04))
    .force('y', d3.forceY(height / 2).strength(0.04))
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
  if (linkForce) linkForce.links(edges);
  simulation.alpha(0.3).restart();
}

function renderTick() {
  if (!edgeGroup || !nodeGroup || !particleGroup) return;
  const now = Date.now();

  // --- Edges ---
  const edgeSel = edgeGroup.selectAll<SVGGElement, AgentEdge>('.edge-group')
    .data(edges, d => edgeKey(d.sourceId, d.targetId) + d.port);

  const edgeEnter = edgeSel.enter().append('g').attr('class', 'edge-group');
  edgeEnter.append('path').attr('class', 'edge-path');

  const edgeMerged = edgeEnter.merge(edgeSel);

  edgeMerged.select('.edge-path')
    .attr('d', d => {
      const s = d.source as AgentNode;
      const t = d.target as AgentNode;
      return edgePath(s.x || 0, s.y || 0, t.x || 0, t.y || 0);
    })
    .attr('fill', 'none')
    .attr('stroke', d => edgeColor(d))
    .attr('stroke-width', d => edgeWidth(d))
    .attr('stroke-opacity', d => edgeOpacity(d))
    .attr('marker-end', 'url(#arrow)');

  edgeSel.exit().remove();

  // --- Nodes ---
  const nodeSel = nodeGroup.selectAll<SVGGElement, AgentNode>('.agent-node')
    .data(nodes, d => d.id);

  const nodeEnter = nodeSel.enter().append('g').attr('class', 'agent-node');

  nodeEnter.append('circle').attr('class', 'activity-ring')
    .attr('fill', 'none').attr('stroke', '#7c3aed').attr('stroke-width', 2).attr('opacity', 0);

  nodeEnter.append('circle').attr('class', 'node-circle').attr('stroke-width', 2);

  nodeEnter.append('circle').attr('class', 'status-dot')
    .attr('r', 5).attr('stroke', '#111827').attr('stroke-width', 1.5);

  nodeEnter.append('text').attr('class', 'node-icon')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('pointer-events', 'none');

  nodeEnter.append('text').attr('class', 'node-label')
    .attr('text-anchor', 'middle').attr('fill', '#d1d5db')
    .attr('font-size', '11px').attr('font-weight', '500').attr('pointer-events', 'none');

  nodeEnter.on('click', (_event, d) => { selectAgent(d.id); });

  nodeEnter.call(
    d3.drag<SVGGElement, AgentNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation?.alphaTarget(0.2).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => {
        if (!event.active) simulation?.alphaTarget(0);
        d.fx = null; d.fy = null;
      })
  );

  const nodeMerged = nodeEnter.merge(nodeSel);

  nodeMerged.attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);

  nodeMerged.select('.node-circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => isBusy(d) ? 'url(#node-gradient-active)' : 'url(#node-gradient-idle)')
    .attr('stroke', d => isBusy(d) ? '#a78bfa' : (d.apiStatus === 'running' ? '#4b5563' : '#991b1b'))
    .attr('filter', d => isBusy(d) ? 'url(#agent-glow)' : null);

  nodeMerged.select('.status-dot')
    .attr('cx', d => nodeRadius(d) * 0.7)
    .attr('cy', d => -nodeRadius(d) * 0.7)
    .attr('fill', d => d.apiStatus === 'running' ? (isBusy(d) ? '#22c55e' : '#6b7280') : '#ef4444');

  nodeMerged.select('.node-icon')
    .attr('font-size', d => `${nodeRadius(d) * 0.8}px`)
    .text(d => d.icon);

  nodeMerged.select('.node-label')
    .attr('y', d => nodeRadius(d) + 16)
    .text(d => d.name);

  nodeMerged.select('.activity-ring')
    .attr('r', d => nodeRadius(d))
    .attr('stroke', d => isBusy(d) ? '#7c3aed' : 'none')
    .attr('opacity', d => isBusy(d) ? 0.4 + 0.3 * Math.sin(now / 600) : 0)
    .attr('stroke-width', d => isBusy(d) ? 2 + Math.sin(now / 600) : 0);

  nodeSel.exit().remove();

  // --- Particles ---
  particles = particles.filter(p => {
    const age = now - p.birth;
    p.progress = age / PARTICLE_DURATION_MS;
    return p.progress < 1;
  });

  const particleSel = particleGroup.selectAll<SVGCircleElement, Particle>('.particle')
    .data(particles, d => d.id);

  particleSel.enter()
    .append('circle').attr('class', 'particle').attr('r', 4).attr('opacity', 0.9)
    .merge(particleSel)
    .attr('fill', d => d.color)
    .attr('opacity', d => 1 - d.progress * 0.5)
    .attr('r', d => 3 + (1 - d.progress) * 2)
    .each(function (d) {
      const edge = edges.find(e => edgeKey(e.sourceId, e.targetId) === d.edgeKey);
      if (!edge) { d3.select(this).attr('opacity', 0); return; }
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

function handleResize() {
  if (!containerEl.value || !svgSelection) return;
  width = containerEl.value.clientWidth || 800;
  height = containerEl.value.clientHeight || 600;
  svgSelection.attr('width', width).attr('height', height);
  if (simulation) {
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    simulation.alpha(0.3).restart();
  }
}

// --- Lifecycle ---

let prevActivityLength = 0;

watch(
  () => props.activity,
  (newActivity) => {
    const newEvents = newActivity.slice(prevActivityLength);
    prevActivityLength = newActivity.length;

    processActivity();

    for (const ev of newEvents) {
      spawnParticle(ev);
    }
  },
  { deep: true }
);

onMounted(() => {
  nextTick(async () => {
    initSvg();
    await loadTopology();
    processActivity();
    startAnimationLoop();

    topologyInterval = setInterval(loadTopology, TOPOLOGY_POLL_MS);

    if (containerEl.value) {
      resizeObserver = new ResizeObserver(() => handleResize());
      resizeObserver.observe(containerEl.value);
    }
  });
});

onUnmounted(() => {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  if (topologyInterval !== null) clearInterval(topologyInterval);
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

.agent-graph-svg :deep(.particle) {
  filter: drop-shadow(0 0 3px currentColor);
}

.agent-graph-svg :deep(.agent-node) {
  cursor: pointer;
}

.agent-graph-svg :deep(.agent-node:active) {
  cursor: grabbing;
}

/* Detail panel CSS removed — now in AgentDetailPanel.vue */
</style>
