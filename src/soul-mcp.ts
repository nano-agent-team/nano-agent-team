/**
 * Soul MCP Tools — atomic Obsidian file write + NATS kick for each tool.
 *
 * 10 tools: create_goal, create_idea, update_idea, create_plan,
 *           ask_user, answer_question, send_to_consciousness, journal_log,
 *           dispatch_task, list_agents
 *
 * Each tool validates IDs, writes atomically (tmp + rename), and publishes
 * a NATS kick where applicable.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NatsConnection } from 'nats';
import { publish } from './nats-client.js';
import { emitActivity } from './activity-emitter.js';
import { logger } from './logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function validateId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(`Invalid ${label}: must match /^[a-zA-Z0-9_-]+$/`);
  }
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Atomic write: writeFileSync to tmp, renameSync to final path. */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** Build YAML frontmatter + body Markdown content. */
function buildFrontmatter(fields: Record<string, string | undefined>, body?: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  if (body) lines.push('', body);
  return lines.join('\n') + '\n';
}

/** Parse YAML frontmatter from file content. Returns { fields, body }. */
function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const fields: Record<string, string> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fields, body: content };
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { fields, body: match[2] };
}

function textResult(obj: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true as const };
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register Soul MCP tools on the given McpServer.
 *
 * @param server    McpServer instance to register tools on.
 * @param nc        NATS connection for publishing kicks.
 * @param dataDir   Control plane data directory (e.g. /data).
 * @param agentId   ID of the calling agent (used as "from" in ask_user).
 * @param permissions Array of allowed tool names (e.g. ["create_goal","create_idea"]).
 */
/** Agent info returned by listAgents callback */
export interface AgentInfo {
  id: string;
  status: string;
  description?: string;
}

export function registerSoulTools(
  server: McpServer,
  nc: NatsConnection,
  dataDir: string,
  agentId: string,
  permissions: string[] | '*',
  agentOutputs?: Record<string, string>,
  listAgents?: () => AgentInfo[],
): void {
  const obsidianBase = path.join(dataDir, 'obsidian', 'Consciousness');
  const questionsBase = path.join(dataDir, 'questions');

  function allowed(toolName: string): boolean {
    if (permissions === '*') return true;
    return Array.isArray(permissions) && permissions.includes(toolName);
  }

  // ── create_goal ─────────────────────────────────────────────────────────────

  if (allowed('create_goal')) {
    server.tool(
      'create_goal',
      'Create a new goal in Obsidian. No NATS kick — goals are passive.',
      {
        title:       z.string().describe('Goal title'),
        description: z.string().describe('Goal description'),
      },
      async ({ title, description }) => {
        try {
          const goalId = generateId('goal');
          const filePath = path.join(obsidianBase, 'goals', `${goalId}.md`);
          const content = buildFrontmatter(
            { id: goalId, title, status: 'active', created: new Date().toISOString() },
            description,
          );
          atomicWrite(filePath, content);
          return textResult({ goalId });
        } catch (err: unknown) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  // ── create_idea ─────────────────────────────────────────────────────────────

  if (allowed('create_idea')) {
    server.tool(
      'create_idea',
      'Create an idea linked to a goal. Publishes soul.idea.pending NATS kick.',
      {
        goalId:      z.string().describe('Parent goal ID'),
        title:       z.string().describe('Short idea title for display'),
        description: z.string().describe('Idea description'),
      },
      async ({ goalId, title, description }) => {
        try {
          validateId(goalId, 'goalId');
          const ideaId = generateId('idea');
          const filePath = path.join(obsidianBase, 'ideas', `${ideaId}.md`);
          const content = buildFrontmatter(
            { id: ideaId, goal: goalId, title, status: 'pending_review', created: new Date().toISOString() },
            description,
          );
          atomicWrite(filePath, content);
          await publish(nc, 'soul.idea.pending', JSON.stringify({ ideaId, path: filePath }));
          emitActivity(nc, {
            agent: agentId, type: 'idea', entityId: ideaId,
            summary: `New idea: ${description}`, timestamp: Date.now(),
          });
          return textResult({ ideaId });
        } catch (err: unknown) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  // ── update_idea ─────────────────────────────────────────────────────────────

  if (allowed('update_idea')) {
    server.tool(
      'update_idea',
      'Update an existing idea. If conscience_verdict is set, publishes soul.idea.approved, soul.idea.rejected, or soul.idea.boundary.',
      {
        ideaId:            z.string().describe('Idea ID to update'),
        status:            z.string().optional().describe('New status'),
        conscience_verdict: z.enum(['approved', 'rejected', 'boundary']).optional().describe('Conscience verdict'),
        conscience_reason:  z.string().optional().describe('Reason for verdict'),
        conscience_boundary: z.string().optional().describe('What is OK vs what needs confirmation'),
      },
      async ({ ideaId, status, conscience_verdict, conscience_reason, conscience_boundary }) => {
        try {
          validateId(ideaId, 'ideaId');
          const filePath = path.join(obsidianBase, 'ideas', `${ideaId}.md`);
          if (!fs.existsSync(filePath)) return errorResult(`Idea ${ideaId} not found`);

          const raw = fs.readFileSync(filePath, 'utf-8');
          const { fields, body } = parseFrontmatter(raw);

          if (status) fields.status = status;
          if (conscience_verdict) fields.conscience_verdict = conscience_verdict;
          if (conscience_reason) fields.conscience_reason = conscience_reason;
          if (conscience_boundary) fields.conscience_boundary = conscience_boundary;
          fields.updated = new Date().toISOString();

          atomicWrite(filePath, buildFrontmatter(fields, body));

          if (conscience_verdict) {
            const timestamp = new Date().toISOString();
            const content = fs.readFileSync(filePath, 'utf-8');
            const turnMatch = content.match(/### Turn (\d+)/g);
            const turnNum = turnMatch ? turnMatch.length + 1 : 1;
            const boundaryLine = conscience_boundary ? `\n**Boundary:** ${conscience_boundary}` : '';
            const entry = `\n### Turn ${turnNum} — Conscience (${timestamp})\n**Verdict:** ${conscience_verdict}${boundaryLine}\n**Reason:** ${conscience_reason || 'No reason given'}\n`;
            if (content.includes('## Dialogue')) {
              fs.appendFileSync(filePath, entry);
            } else {
              fs.appendFileSync(filePath, `\n## Dialogue\n${entry}`);
            }
          }

          if (conscience_verdict === 'approved') {
            await publish(nc, 'soul.idea.approved', JSON.stringify({ ideaId, path: filePath }));
          } else if (conscience_verdict === 'rejected') {
            await publish(nc, 'soul.idea.rejected', JSON.stringify({
              ideaId, path: filePath, reason: conscience_reason ?? '',
            }));
          } else if (conscience_verdict === 'boundary') {
            await publish(nc, 'soul.idea.boundary', JSON.stringify({
              ideaId, path: filePath, boundary: conscience_boundary,
            }));
          }

          if (conscience_verdict) {
            emitActivity(nc, {
              agent: agentId, type: 'dialogue', entityId: ideaId,
              summary: `Verdict: ${conscience_verdict} on idea ${ideaId}`,
              from: 'conscience', to: 'consciousness', timestamp: Date.now(),
            });
            emitActivity(nc, {
              agent: agentId, type: 'idea', entityId: ideaId,
              summary: `Idea ${ideaId} status: ${conscience_verdict}`, timestamp: Date.now(),
            });
          }

          return textResult({ ok: true });
        } catch (err: unknown) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  // ── create_plan ─────────────────────────────────────────────────────────────

  if (allowed('create_plan')) {
    server.tool(
      'create_plan',
      'Create an action plan for an approved idea. Publishes soul.plan.ready.',
      {
        ideaId:  z.string().describe('Source idea ID'),
        title:   z.string().describe('Plan title'),
        content: z.string().describe('Plan content / action steps'),
      },
      async ({ ideaId, title, content }) => {
        try {
          validateId(ideaId, 'ideaId');
          const planId = generateId('plan');
          const filePath = path.join(obsidianBase, 'plans', `${planId}.md`);
          const fileContent = buildFrontmatter(
            { id: planId, idea: ideaId, title, status: 'pending', created: new Date().toISOString() },
            content,
          );
          atomicWrite(filePath, fileContent);
          await publish(nc, 'soul.plan.ready', JSON.stringify({ planId, path: filePath }));
          emitActivity(nc, {
            agent: agentId, type: 'plan', entityId: planId,
            summary: `New plan: ${title}`, timestamp: Date.now(),
          });
          return textResult({ planId });
        } catch (err: unknown) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  // ── ask_user ────────────────────────────────────────────────────────────────

  if (allowed('ask_user')) {
    server.tool(
      'ask_user',
      'Ask the user a question via chat agent. Async — answer arrives later via agent.{id}.answer.',
      {
        question: z.string().describe('Question to ask the user'),
        context:  z.string().optional().describe('Context for the question (max 1KB)'),
      },
      async ({ question, context }) => {
        try {
          if (context && context.length > 1024) {
            return errorResult('Context exceeds 1KB limit');
          }
          const questionId = generateId('q');
          const filePath = path.join(questionsBase, `${questionId}.json`);
          const data = {
            id: questionId,
            from: agentId,
            question,
            context: context ?? null,
            status: 'pending',
            answer: null,
            created: new Date().toISOString(),
            answered: null,
          };
          atomicWrite(filePath, JSON.stringify(data, null, 2));
          await publish(nc, 'agent.chat-agent.inbox', JSON.stringify({
            type: 'question',
            questionId,
            question,
            context: context ?? null,
            from: agentId,
          }));
          // Push question to dashboard UI immediately so user sees it
          await publish(nc, 'chat.push', JSON.stringify({
            text: `**Otázka od systému:**\n\n${question}`,
            from: agentId,
          }));
          emitActivity(nc, {
            agent: agentId, type: 'user', summary: 'Question asked',
            from: agentId, to: 'user', subtype: 'question', timestamp: Date.now(),
          });

          // Create a chat thread for this question
          const threadDir = path.join(dataDir, 'chat', 'threads');
          try {
            fs.mkdirSync(threadDir, { recursive: true });
            const threadId = `ask-${questionId}`;
            const threadPath = path.join(threadDir, `${threadId}.json`);
            const thread = {
              id: threadId,
              title: question.substring(0, 50),
              messages: [{ role: 'agent', text: question, agentId, ts: Date.now() }],
              pending: true,
              questionId,
              createdAt: Date.now(),
            };
            fs.writeFileSync(threadPath, JSON.stringify(thread, null, 2));
          } catch { /* ignore thread creation failure */ }

          return textResult({ questionId, status: 'pending' });
        } catch (err: unknown) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  // ── answer_question ─────────────────────────────────────────────────────────

  if (allowed('answer_question')) {
    server.tool(
      'answer_question',
      'Answer a pending question. Reads the question file to find the originating agent and delivers the answer.',
      {
        questionId: z.string().describe('Question ID to answer'),
        answer:     z.string().describe('The answer to deliver'),
      },
      async ({ questionId, answer }) => {
        try {
          validateId(questionId, 'questionId');
          const filePath = path.join(questionsBase, `${questionId}.json`);
          if (!fs.existsSync(filePath)) return errorResult('Question not found');

          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const fromAgent: string = data.from;
          if (!fromAgent) return errorResult('Question has no "from" field');

          data.status = 'answered';
          data.answer = answer;
          data.answered = new Date().toISOString();
          atomicWrite(filePath, JSON.stringify(data, null, 2));

          await publish(nc, `agent.${fromAgent}.answer`, JSON.stringify({
            type: 'user_answer',
            questionId,
            answer,
          }));
          emitActivity(nc, {
            agent: agentId, type: 'user', summary: 'Answer delivered',
            from: 'user', to: fromAgent, subtype: 'answer', timestamp: Date.now(),
          });
          return textResult({ ok: true });
        } catch (err: unknown) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  // ── send_to_consciousness ───────────────────────────────────────────────────

  if (allowed('send_to_consciousness')) {
    server.tool(
      'send_to_consciousness',
      'Relay a user intent to consciousness. Writes to inbox and publishes NATS kick.',
      {
        intent:  z.string().describe('Extracted user intent'),
        context: z.string().optional().describe('Additional context'),
      },
      async ({ intent, context }) => {
        try {
          const messageId = generateId('msg');
          const filePath = path.join(obsidianBase, 'inbox', `${messageId}.md`);
          const content = buildFrontmatter(
            { id: messageId, from: agentId, created: new Date().toISOString() },
            context ? `${intent}\n\n**Context:** ${context}` : intent,
          );
          atomicWrite(filePath, content);
          await publish(nc, 'soul.consciousness.inbox', JSON.stringify({ messageId, path: filePath }));
          return textResult({ messageId });
        } catch (err: unknown) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  // ── journal_log ─────────────────────────────────────────────────────────────

  if (allowed('journal_log')) {
    server.tool(
      'journal_log',
      'Append an entry to the daily journal. No NATS kick — journal is append-only.',
      {
        entry: z.string().describe('Journal entry text'),
      },
      async ({ entry }) => {
        try {
          const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
          const filePath = path.join(obsidianBase, 'journal', `${date}.md`);
          const dir = path.dirname(filePath);
          fs.mkdirSync(dir, { recursive: true });
          const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
          const line = `\n- **${timestamp}** [${agentId}] ${entry}\n`;
          fs.appendFileSync(filePath, line, 'utf-8');
          return textResult({ ok: true });
        } catch (err: unknown) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  // ── evaluate_self ────────────────────────────────────────────────────────────

  if (allowed('evaluate_self')) {
    server.tool('evaluate_self', 'Trigger consciousness self-evaluation loop', {}, async () => {
      try {
        await publish(nc, 'soul.consciousness.evaluate', JSON.stringify({
          type: 'self_kick',
          timestamp: new Date().toISOString(),
        }));
        emitActivity(nc, {
          agent: agentId, type: 'thinking', summary: 'Self-evaluation triggered',
          timestamp: Date.now(),
        });
        return { content: [{ type: 'text', text: 'Self-evaluation scheduled.' }] };
      } catch (err) {
        logger.warn({ err }, 'evaluate_self publish failed (AlarmClock will retry)');
        return { content: [{ type: 'text', text: 'Self-evaluation publish failed; AlarmClock will retry.' }] };
      }
    });
  }

  // ── publish_signal ──────────────────────────────────────────────────────────

  if (allowed('publish_signal')) {
    server.tool('publish_signal', 'Publish a signal to a named output declared in your manifest.', {
      output: z.string().describe('Output port name from your manifest'),
      payload: z.string().describe('JSON payload'),
    }, async ({ output, payload }) => {
      try { JSON.parse(payload); } catch { return errorResult('payload must be valid JSON'); }

      if (!agentOutputs || !agentOutputs[output]) {
        return errorResult(`Unknown output "${output}". Available: ${Object.keys(agentOutputs || {}).join(', ')}`);
      }
      const subject = agentOutputs[output];
      await publish(nc, subject, payload);
      emitActivity(nc, {
        agent: agentId, type: 'action',
        summary: `Signal: ${output}`, timestamp: Date.now(),
      });
      return textResult({ ok: true, output, subject });
    });
  }

  // ── continue_dialogue ────────────────────────────────────────────────────────

  if (allowed('continue_dialogue')) {
    server.tool('continue_dialogue', 'Continue dialogue with conscience — add counter-arguments', {
      ideaId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      argument: z.string().min(1),
    }, async ({ ideaId, argument }) => {
      const ideasDir = path.join(obsidianBase, 'ideas');
      const filePath = path.join(ideasDir, `${ideaId}.md`);
      if (!fs.existsSync(filePath)) {
        return { content: [{ type: 'text', text: `Idea ${ideaId} not found.` }] };
      }

      // Append to ## Dialogue section
      const timestamp = new Date().toISOString();
      const existing = fs.readFileSync(filePath, 'utf-8');
      const turnMatch = existing.match(/### Turn (\d+)/g);
      const turnNum = turnMatch ? turnMatch.length + 1 : 1;
      const dialogueEntry = `\n### Turn ${turnNum} — Consciousness (${timestamp})\n**Counter-argument:** ${argument}\n`;

      if (existing.includes('## Dialogue')) {
        fs.appendFileSync(filePath, dialogueEntry);
      } else {
        fs.appendFileSync(filePath, `\n## Dialogue\n${dialogueEntry}`);
      }

      await publish(nc, 'soul.conscience.dialogue', JSON.stringify({ ideaId, path: filePath }));
      emitActivity(nc, {
        agent: agentId, type: 'dialogue', entityId: ideaId,
        summary: `Counter-argument on idea ${ideaId}`,
        from: 'consciousness', to: 'conscience', timestamp: Date.now(),
      });

      return { content: [{ type: 'text', text: `Dialogue continued on idea ${ideaId}, turn ${turnNum}.` }] };
    });
  }

  // ── dispatch_task ───────────────────────────────────────────────────────────

  if (allowed('dispatch_task')) {
    server.tool('dispatch_task', 'Send a task to any agent by ID. Publishes to agent.{agentId}.inbox.', {
      targetAgent: z.string().regex(SAFE_ID).describe('Agent ID to send the task to'),
      payload: z.string().describe('JSON payload describing the task'),
    }, async ({ targetAgent, payload }) => {
      try { JSON.parse(payload); } catch { return errorResult('payload must be valid JSON'); }

      if (listAgents) {
        const agents = listAgents();
        if (!agents.some(a => a.id === targetAgent)) {
          return errorResult(`Agent "${targetAgent}" not found. Available: ${agents.map(a => a.id).join(', ')}`);
        }
      }

      const subject = `agent.${targetAgent}.inbox`;
      await publish(nc, subject, payload);
      emitActivity(nc, {
        agent: agentId, type: 'action',
        summary: `Dispatched task to ${targetAgent}`, timestamp: Date.now(),
      });
      return textResult({ ok: true, targetAgent, subject });
    });
  }

  // ── list_agents ─────────────────────────────────────────────────────────────

  if (allowed('list_agents')) {
    server.tool('list_agents', 'List all currently registered agents and their status.', {}, async () => {
      if (!listAgents) {
        return errorResult('list_agents not available in this context');
      }
      const agents = listAgents();
      return textResult({ agents });
    });
  }
}
