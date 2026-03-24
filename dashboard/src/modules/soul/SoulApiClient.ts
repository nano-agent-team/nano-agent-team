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
