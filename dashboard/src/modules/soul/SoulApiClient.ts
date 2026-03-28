export interface SoulState {
  goals: SoulGoal[];
  orphanIdeas: SoulIdea[];
  orphanPlans: SoulPlan[];
}
export interface SoulGoal { id: string; title: string; description: string; status: string; ideas: SoulIdea[]; }
export interface SoulIdea { id: string; title: string; description: string; status: string; conscience_verdict?: string; conscience_boundary?: string; conscience_reason?: string; dialogue: DialogueTurn[]; plans: SoulPlan[]; }
export interface SoulPlan { id: string; title: string; description: string; status: string; tasks: SoulTask[]; }
export interface SoulTask { id: string; title: string; done: boolean; }
export interface DialogueTurn { turn: number; agent: string; verdict?: string; boundary?: string; reason?: string; argument?: string; timestamp: string; }

export interface ActivityEvent {
  agent: string; type: string; entityId?: string; summary: string;
  from?: string; to?: string; subtype?: string; timestamp: number;
}

export interface AgentTopologyNode {
  id: string; name: string; description: string; icon: string; status: string;
  subscribe_topics: string[]; outputs: Array<{ port: string; subject: string }>;
}
export interface AgentTopologyEdge { from: string; to: string; subject: string; port: string; }
export interface AgentTopology { agents: AgentTopologyNode[]; edges: AgentTopologyEdge[]; }

export async function fetchAgentTopology(): Promise<AgentTopology> {
  const res = await fetch('/api/agents/topology');
  if (!res.ok) return { agents: [], edges: [] };
  return res.json();
}

export async function fetchSoulState(filters?: { status?: string }): Promise<SoulState> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  const url = `/api/soul/state${params.toString() ? '?' + params : ''}`;
  const res = await fetch(url);
  if (res.status === 503) return { goals: [], orphanIdeas: [], orphanPlans: [] };
  if (!res.ok) throw new Error(`Soul state: ${res.status}`);
  return res.json();
}

export function connectActivityStream(onEvent: (event: ActivityEvent) => void): () => void {
  const es = new EventSource('/api/soul/activity');
  es.addEventListener('activity', (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch { /* ignore parse errors */ }
  });
  es.onerror = () => { /* auto-reconnects */ };
  return () => es.close();
}

// ── Chat Threads ────────────────────────────────────────────────────────────

export interface ChatThread {
  id: string;
  title: string;
  pending: boolean;
  lastMessage?: { role: string; text: string; ts: number };
  messageCount: number;
}

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  agentId?: string;
  ts: number;
}

export async function fetchThreads(): Promise<ChatThread[]> {
  const res = await fetch('/api/chat/threads');
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMessages(threadId: string): Promise<ChatMessage[]> {
  const res = await fetch(`/api/chat/threads/${threadId}/messages`);
  if (!res.ok) return [];
  return res.json();
}

export async function sendMessage(threadId: string, text: string): Promise<string> {
  const res = await fetch(`/api/chat/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) return '';
  const data = await res.json();
  return data.reply ?? '';
}

export async function createThread(title: string): Promise<ChatThread | null> {
  const res = await fetch('/api/chat/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Agent Activity Stream ───────────────────────────────────────────────────

export interface AgentActivityEvent {
  type: 'tool_call' | 'thinking' | 'text' | 'signal';
  summary: string;
  detail?: string;
  toolName?: string;
  timestamp: number;
}

export function connectAgentStream(agentId: string, onEvent: (e: AgentActivityEvent) => void): () => void {
  const es = new EventSource(`/api/agents/${agentId}/stream`);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch { /* ignore */ }
  };
  es.onerror = () => { /* auto-reconnects */ };
  return () => es.close();
}

// ── Journal ─────────────────────────────────────────────────────────────────

export interface JournalEntry {
  timestamp: string;
  agent: string;
  text: string;
}

export async function fetchJournal(): Promise<JournalEntry[]> {
  const res = await fetch('/api/soul/journal');
  if (!res.ok) return [];
  return res.json();
}
