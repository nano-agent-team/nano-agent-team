/**
 * Pure graph data transformation utilities for WorkflowGraph.vue
 * Extracted as a separate module so they can be unit-tested independently.
 */

import type { Node, Edge } from '@vue-flow/core'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentState {
  agentId: string
  status: 'starting' | 'running' | 'dead' | 'restarting' | 'rolling-over'
  restartCount: number
  startedAt?: string
  lastHeartbeat?: string
  containerId?: string
  busy?: boolean
  task?: string
}

export interface WorkflowBinding {
  inputs?: Record<string, string | { from: string; to: string }>
  outputs?: Record<string, string>
}

export interface DispatchConfig {
  strategy: string
  to: string[]
}

export interface WorkflowManifest {
  id: string
  name: string
  version: string
  agents: string[]
  instances?: Record<string, { manifest: string; count?: number; vault?: string }>
  dispatch?: Record<string, DispatchConfig>
  bindings?: Record<string, WorkflowBinding>
  pipeline?: { topics?: Record<string, string> }
}

export interface AgentNodeData {
  agentId: string
  status: string
  busy: boolean
  task?: string
  restartCount: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a map: NATS subject → agentId (using binding outputs).
 */
function buildSubjectToAgentMap(wf: WorkflowManifest): Map<string, string> {
  const map = new Map<string, string>()
  if (!wf.bindings) return map

  const instanceIds: string[] = wf.instances
    ? Object.keys(wf.instances)
    : wf.agents

  for (const instanceId of instanceIds) {
    const binding = wf.bindings[instanceId]
    if (!binding?.outputs) continue
    for (const subject of Object.values(binding.outputs)) {
      map.set(subject, instanceId)
    }
  }
  return map
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Pure transformation: WorkflowManifest + AgentState[] → { nodes, edges }
 */
export function buildGraphData(
  wf: WorkflowManifest,
  agentStates: AgentState[],
): { nodes: Node[]; edges: Edge[] } {
  const resultNodes: Node[] = []
  const resultEdges: Edge[] = []

  const stateMap = new Map(agentStates.map(a => [a.agentId, a]))

  const workflowInstanceIds: string[] = wf.instances
    ? Object.keys(wf.instances)
    : wf.agents

  const workflowIdSet = new Set(workflowInstanceIds)

  const subjectToAgent = buildSubjectToAgentMap(wf)

  // ── Collect edge list ───────────────────────────────────────────────────────
  const edgeList: { source: string; target: string; label: string; id: string }[] = []

  if (wf.bindings) {
    for (const instanceId of workflowInstanceIds) {
      const binding = wf.bindings[instanceId]
      if (!binding?.inputs) continue

      for (const [, inputValue] of Object.entries(binding.inputs)) {
        const subject = typeof inputValue === 'string' ? inputValue : inputValue.from
        const sourceAgent = subjectToAgent.get(subject)
        if (sourceAgent && sourceAgent !== instanceId) {
          const edgeId = `e-${sourceAgent}-${instanceId}-${subject}`
          if (!edgeList.find(e => e.id === edgeId)) {
            edgeList.push({ source: sourceAgent, target: instanceId, label: subject, id: edgeId })
          }
        }
      }
    }
  }

  if (wf.dispatch) {
    for (const [subject, dispatchConfig] of Object.entries(wf.dispatch)) {
      const sourceAgent = subjectToAgent.get(subject)
      for (const targetId of dispatchConfig.to) {
        const edgeId = `e-dispatch-${subject}-${targetId}`
        const label = dispatchConfig.strategy !== 'competing'
          ? `${subject} [${dispatchConfig.strategy}]`
          : subject
        if (!edgeList.find(e => e.id === edgeId)) {
          edgeList.push({
            source: sourceAgent ?? subject,
            target: targetId,
            label,
            id: edgeId,
          })
        }
      }
    }
  }

  // ── Layered layout ──────────────────────────────────────────────────────────
  const layers = computeLayers(workflowInstanceIds, edgeList)

  const X_GAP = 280
  const Y_GAP = 120

  for (const [layerIdx, layerNodes] of layers.entries()) {
    const xPos = layerIdx * X_GAP + 40
    for (const [nodeIdx, instanceId] of layerNodes.entries()) {
      const state = stateMap.get(instanceId)
      const yPos = nodeIdx * Y_GAP + 40

      resultNodes.push({
        id: instanceId,
        type: 'agent',
        position: { x: xPos, y: yPos },
        data: {
          agentId: instanceId,
          status: state?.status ?? 'unknown',
          busy: state?.busy ?? false,
          task: state?.task,
          restartCount: state?.restartCount ?? 0,
        } as AgentNodeData,
      })
    }
  }

  // ── Isolated nodes (in health but not in workflow) ─────────────────────────
  const maxX = layers.length * X_GAP + 40
  const isolatedAgents = agentStates.filter(a => !workflowIdSet.has(a.agentId))
  for (const [idx, agent] of isolatedAgents.entries()) {
    resultNodes.push({
      id: agent.agentId,
      type: 'agent',
      position: { x: maxX, y: idx * Y_GAP + 40 },
      data: {
        agentId: agent.agentId,
        status: agent.status,
        busy: agent.busy ?? false,
        task: agent.task,
        restartCount: agent.restartCount,
      } as AgentNodeData,
    })
  }

  // ── Add edges to result (only when both endpoints exist) ───────────────────
  for (const e of edgeList) {
    const sourceExists = resultNodes.some(n => n.id === e.source)
    const targetExists = resultNodes.some(n => n.id === e.target)
    if (sourceExists && targetExists) {
      resultEdges.push({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        type: 'smoothstep',
        style: { stroke: 'var(--border)', strokeWidth: 1.5 },
        labelStyle: { fill: 'var(--text-muted)', fontSize: '10px' },
        labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.85 },
      })
    }
  }

  return { nodes: resultNodes, edges: resultEdges }
}

/**
 * Compute left-to-right layers based on dependency chain.
 * Entry agents (no incoming edges) are Layer 0.
 * Handles cycles gracefully via iteration-capped propagation.
 */
export function computeLayers(
  instanceIds: string[],
  edges: { source: string; target: string }[],
): string[][] {
  const layerMap = new Map<string, number>()

  for (const id of instanceIds) {
    layerMap.set(id, 0)
  }

  // Iteratively propagate layers until stable
  const MAX_ITER = instanceIds.length + 1
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let changed = false
    for (const edge of edges) {
      const sourceLayer = layerMap.get(edge.source) ?? 0
      const targetLayer = layerMap.get(edge.target) ?? 0
      const desired = sourceLayer + 1
      if (desired > targetLayer && layerMap.has(edge.target)) {
        layerMap.set(edge.target, desired)
        changed = true
      }
    }
    if (!changed) break
  }

  // Group into layer buckets
  const maxLayer = Math.max(0, ...layerMap.values())
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => [])
  for (const [id, layer] of layerMap.entries()) {
    layers[layer].push(id)
  }

  return layers.filter(l => l.length > 0)
}
