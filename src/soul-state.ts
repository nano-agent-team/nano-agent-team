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
interface SoulPlan { id: string; title: string; description: string; status: string; tasks: SoulTask[]; ideaId?: string; }
interface SoulIdea {
  id: string; title: string; description: string; status: string;
  conscience_verdict?: string; conscience_boundary?: string; conscience_reason?: string;
  dialogue: DialogueTurn[]; plans: SoulPlan[]; goalId?: string;
}
interface SoulGoal { id: string; title: string; description: string; status: string; ideas: SoulIdea[]; }
export interface SoulState {
  goals: SoulGoal[];
  orphanIdeas: SoulIdea[];
  orphanPlans: SoulPlan[];
}

export interface JournalEntry {
  timestamp: string;
  agent: string;
  text: string;
}

/** Read journal entries from today (or a specific date). Returns newest first. */
export function readJournal(dataDir: string, date?: string): JournalEntry[] {
  const d = date || new Date().toISOString().slice(0, 10);
  const filePath = path.join(dataDir, 'obsidian', 'Consciousness', 'journal', `${d}.md`);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries: JournalEntry[] = [];
  const regex = /- \*\*(\d{2}:\d{2}:\d{2})\*\* \[([^\]]+)\] ([\s\S]*?)(?=\n- \*\*\d{2}:\d{2}:\d{2}\*\*|$)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    entries.push({
      timestamp: `${d}T${match[1]}`,
      agent: match[2],
      text: match[3].trim(),
    });
  }
  return entries.reverse(); // newest first
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
  const title = resolveTitle(content, id);
  const description = extractBody(content);
  const status = extractField(content, 'status') || 'pending';
  return { id, title, description, status, ideas: [] };
}

function parseIdeaFile(filePath: string): SoulIdea | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const id = path.basename(filePath, '.md');
  const title = resolveTitle(content, id);
  const description = extractBody(content);
  const status = extractField(content, 'status') || 'pending';
  const conscience_verdict = extractField(content, 'conscience_verdict');
  const conscience_boundary = extractField(content, 'conscience_boundary');
  const conscience_reason = extractField(content, 'conscience_reason');
  const goalId = extractField(content, 'goal');
  const dialogue = parseDialogue(content);
  return { id, title, description, status, conscience_verdict, conscience_boundary, conscience_reason, dialogue, plans: [], goalId };
}

function parsePlanFile(filePath: string): SoulPlan | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const id = path.basename(filePath, '.md');
  const title = resolveTitle(content, id);
  const description = extractBody(content);
  const status = extractField(content, 'status') || 'pending';
  const ideaId = extractField(content, 'idea');
  const tasks = parseTasks(content);
  return { id, title, description, status, tasks, ideaId };
}

function extractField(content: string, field: string): string | undefined {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

/** Extract body text after frontmatter (--- delimited) and before ## Dialogue */
function extractBody(content: string): string {
  // Skip frontmatter block (between --- markers)
  const fmEnd = content.indexOf('\n---', content.indexOf('---') + 1);
  const afterFm = fmEnd >= 0 ? content.slice(fmEnd + 4).trim() : content;
  // Cut off ## Dialogue section if present
  const dialogueIdx = afterFm.indexOf('## Dialogue');
  const body = dialogueIdx >= 0 ? afterFm.slice(0, dialogueIdx).trim() : afterFm;
  return body;
}

/** Extract a readable title: use title field, or first line of body, or ID as last resort */
function resolveTitle(content: string, id: string): string {
  const title = extractField(content, 'title');
  if (title) return title;
  const body = extractBody(content);
  if (body) {
    const firstLine = body.split('\n')[0].replace(/^#+\s*/, '').trim();
    if (firstLine && firstLine.length > 3) return firstLine.slice(0, 80);
  }
  return id;
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
