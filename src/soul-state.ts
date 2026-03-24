import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger.js';

interface DialogueTurn {
  turn: number;
  agent: string;
  verdict?: string;
  boundary?: string;
  reason?: string;
  argument?: string;
  timestamp: string;
}

interface SoulTask { id: string; title: string; done: boolean; }
interface SoulPlan { id: string; title: string; status: string; tasks: SoulTask[]; ideaId?: string; }
interface SoulIdea {
  id: string; title: string; status: string;
  conscience_verdict?: string; conscience_boundary?: string;
  dialogue: DialogueTurn[]; plans: SoulPlan[]; goalId?: string;
}
interface SoulGoal { id: string; title: string; status: string; ideas: SoulIdea[]; }
export interface SoulState {
  goals: SoulGoal[];
  orphanIdeas: SoulIdea[];
  orphanPlans: SoulPlan[];
}

let cache: { state: SoulState; timestamp: number } | null = null;
const CACHE_TTL_MS = 5000;

export function getSoulState(dataDir: string, filters?: { status?: string; since?: number }): SoulState {
  const now = Date.now();
  if (cache && (now - cache.timestamp) < CACHE_TTL_MS) {
    return applyFilters(cache.state, filters);
  }

  const obsidianDir = path.join(dataDir, 'obsidian', 'Consciousness');
  if (!fs.existsSync(obsidianDir)) {
    return { goals: [], orphanIdeas: [], orphanPlans: [] };
  }

  const goals = parseDir<SoulGoal>(path.join(obsidianDir, 'goals'), parseGoalFile);
  const ideas = parseDir<SoulIdea>(path.join(obsidianDir, 'ideas'), parseIdeaFile);
  const plans = parseDir<SoulPlan>(path.join(obsidianDir, 'plans'), parsePlanFile);

  // Build tree: link ideas to goals, plans to ideas
  const linkedIdeaIds = new Set<string>();
  const linkedPlanIds = new Set<string>();

  for (const goal of goals) {
    goal.ideas = ideas.filter(i => i.goalId === goal.id);
    for (const idea of goal.ideas) {
      linkedIdeaIds.add(idea.id);
      idea.plans = plans.filter(p => p.ideaId === idea.id);
      idea.plans.forEach(p => linkedPlanIds.add(p.id));
    }
  }

  const state: SoulState = {
    goals,
    orphanIdeas: ideas.filter(i => !linkedIdeaIds.has(i.id)),
    orphanPlans: plans.filter(p => !linkedPlanIds.has(p.id)),
  };

  cache = { state, timestamp: now };
  return applyFilters(state, filters);
}

function applyFilters(state: SoulState, filters?: { status?: string; since?: number }): SoulState {
  if (!filters) return state;
  let result = { ...state };
  if (filters.status) {
    result.goals = result.goals.filter(g => g.status === filters.status || g.ideas.some(i => i.status === filters.status));
  }
  return result;
}

function parseDir<T>(dir: string, parser: (filePath: string) => T | null): T[] {
  if (!fs.existsSync(dir)) return [];
  const results: T[] = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    try {
      const item = parser(path.join(dir, file));
      if (item) results.push(item);
    } catch (err) {
      logger.warn({ file, err }, 'Failed to parse Obsidian file, skipping');
    }
  }
  return results;
}

function parseGoalFile(filePath: string): SoulGoal | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const id = path.basename(filePath, '.md');
  const title = extractField(content, 'title') || id;
  const status = extractField(content, 'status') || 'pending';
  return { id, title, status, ideas: [] };
}

function parseIdeaFile(filePath: string): SoulIdea | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const id = path.basename(filePath, '.md');
  const title = extractField(content, 'title') || id;
  const status = extractField(content, 'status') || 'pending';
  const conscience_verdict = extractField(content, 'conscience_verdict');
  const conscience_boundary = extractField(content, 'conscience_boundary');
  const goalId = extractField(content, 'goal');
  const dialogue = parseDialogue(content);
  return { id, title, status, conscience_verdict, conscience_boundary, dialogue, plans: [], goalId };
}

function parsePlanFile(filePath: string): SoulPlan | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const id = path.basename(filePath, '.md');
  const title = extractField(content, 'title') || id;
  const status = extractField(content, 'status') || 'pending';
  const ideaId = extractField(content, 'idea');
  const tasks = parseTasks(content);
  return { id, title, status, tasks, ideaId };
}

function extractField(content: string, field: string): string | undefined {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function parseDialogue(content: string): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  const regex = /### Turn (\d+) — (\w+) \(([^)]+)\)\n([\s\S]*?)(?=\n### Turn|\n## |$)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const [, turnStr, agent, timestamp, body] = match;
    const turn: DialogueTurn = { turn: parseInt(turnStr), agent: agent.toLowerCase(), timestamp };
    const verdict = body.match(/\*\*Verdict:\*\* (\w+)/)?.[1];
    const boundary = body.match(/\*\*Boundary:\*\* (.+)/)?.[1];
    const reason = body.match(/\*\*Reason:\*\* (.+)/)?.[1];
    const argument = body.match(/\*\*Counter-argument:\*\* (.+)/)?.[1];
    if (verdict) turn.verdict = verdict;
    if (boundary) turn.boundary = boundary;
    if (reason) turn.reason = reason;
    if (argument) turn.argument = argument;
    turns.push(turn);
  }
  return turns;
}

function parseTasks(content: string): SoulTask[] {
  const tasks: SoulTask[] = [];
  const regex = /- \[([ x])\] (.+)/g;
  let match;
  let idx = 0;
  while ((match = regex.exec(content)) !== null) {
    tasks.push({ id: `task-${idx++}`, title: match[2].trim(), done: match[1] === 'x' });
  }
  return tasks;
}
