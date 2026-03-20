/**
 * GitHubIssuesProvider — GitHub Issues backed implementation of TicketProvider.
 *
 * Ticket IDs: "GH-{number}" (e.g. "GH-42")
 * Status mapping: abstract status ↔ GitHub label "status:{value}"
 * Done/Rejected: issue is closed + label distinguishes them
 *
 * Config:
 *   owner  — GitHub org or user (e.g. "my-org")
 *   repo   — repository name   (e.g. "my-repo")
 *   token  — GitHub PAT with issues:write scope
 */

import type { TicketProvider, StatusMapper } from './provider.js';
import type {
  Ticket,
  TicketComment,
  CreateTicketData,
  UpdateTicketData,
  TicketFilters,
  AbstractStatus,
  TicketPriority,
  TicketType,
} from './types.js';
import { logger } from '../logger.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GitHubProviderConfig {
  owner: string;
  repo: string;
  token: string;
}

// ─── Status mapper ────────────────────────────────────────────────────────────

interface GitHubNativeStatus {
  state: 'open' | 'closed';
  label?: string;  // "status:approved", "status:in_progress", ...
}

const STATUS_LABEL_PREFIX = 'status:';

const ABSTRACT_TO_LABEL: Record<AbstractStatus, string | null> = {
  new:           null,            // open issues without a status label = "new"
  approved:      'status:approved',
  in_progress:   'status:in_progress',
  review:        'status:review',
  done:          null,           // closed, no extra label
  rejected:      'status:rejected',
  pending_input: 'status:pending-input',
};

export class GitHubStatusMapper implements StatusMapper<GitHubNativeStatus> {
  toNative(abstract: AbstractStatus): GitHubNativeStatus {
    const label = ABSTRACT_TO_LABEL[abstract];
    const state: 'open' | 'closed' = (abstract === 'done' || abstract === 'rejected') ? 'closed' : 'open';
    return { state, label: label ?? undefined };
  }

  fromNative(native: GitHubNativeStatus): AbstractStatus {
    if (native.state === 'closed') {
      return native.label === 'status:rejected' ? 'rejected' : 'done';
    }
    if (!native.label) return 'new';
    const map: Record<string, AbstractStatus> = {
      'status:new':           'new',
      'status:approved':      'approved',
      'status:in_progress':   'in_progress',
      'status:review':        'review',
      'status:pending-input': 'pending_input',
    };
    return map[native.label] ?? 'new';
  }
}

// ─── GitHub API types (minimal) ───────────────────────────────────────────────

interface GHLabel { name: string }
interface GHUser  { login: string }

interface GHIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: GHLabel[];
  user: GHUser | null;
  assignee: GHUser | null;
  created_at: string;
  updated_at: string;
}

interface GHComment {
  id: number;
  user: GHUser | null;
  body: string;
  created_at: string;
}

// ─── GitHubIssuesProvider ─────────────────────────────────────────────────────

export class GitHubIssuesProvider implements TicketProvider {
  readonly id = 'github';
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly statusMapper = new GitHubStatusMapper();

  constructor(private readonly config: GitHubProviderConfig) {
    this.baseUrl = `https://api.github.com/repos/${config.owner}/${config.repo}`;
    this.displayName = `GitHub Issues (${config.owner}/${config.repo})`;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  private async ghFetch<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${method} ${url} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // ── Conversion ────────────────────────────────────────────────────────────

  private issueToTicket(issue: GHIssue): Ticket {
    const statusLabel = issue.labels.find(l => l.name.startsWith(STATUS_LABEL_PREFIX));
    const nativeStatus: GitHubNativeStatus = { state: issue.state, label: statusLabel?.name };
    const otherLabels = issue.labels
      .filter(l => !l.name.startsWith(STATUS_LABEL_PREFIX))
      .map(l => l.name);

    // Infer priority from label "priority:HIGH" etc.
    const priorityLabel = issue.labels.find(l => l.name.startsWith('priority:'));
    const priority = priorityLabel
      ? (priorityLabel.name.replace('priority:', '').toUpperCase() as TicketPriority)
      : 'MED';

    // Infer type from label "type:bug" etc.
    const typeLabel = issue.labels.find(l => l.name.startsWith('type:'));
    const type = typeLabel
      ? (typeLabel.name.replace('type:', '') as TicketType)
      : 'task';

    return {
      id: `GH-${issue.number}`,
      title: issue.title,
      body: issue.body,
      status: this.statusMapper.fromNative(nativeStatus),
      priority,
      type,
      assignee: issue.assignee?.login ?? null,
      author: issue.user?.login ?? null,
      labels: otherLabels,
      provider: 'github',
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    };
  }

  private parseId(id: string): number {
    if (!id.startsWith('GH-')) throw new Error(`Invalid GitHub ticket ID: ${id}`);
    return parseInt(id.slice(3), 10);
  }

  // ── Ensure labels exist ───────────────────────────────────────────────────

  private async ensureLabel(name: string, color = 'ededed'): Promise<void> {
    try {
      await this.ghFetch(`/labels/${encodeURIComponent(name)}`);
    } catch {
      try {
        await this.ghFetch('/labels', 'POST', { name, color });
      } catch {
        // Already exists or no permission — ignore
      }
    }
  }

  // ── TicketProvider implementation ─────────────────────────────────────────

  async createTicket(data: CreateTicketData): Promise<Ticket> {
    const labels: string[] = [];
    if (data.priority) { labels.push(`priority:${data.priority}`); }
    if (data.type)     { labels.push(`type:${data.type}`); }
    if (data.labels)   { labels.push(...data.labels); }

    const issue = await this.ghFetch<GHIssue>('/issues', 'POST', {
      title: data.title,
      body: data.body ?? '',
      labels,
      ...(data.assignee ? { assignees: [data.assignee] } : {}),
    });

    logger.info({ id: `GH-${issue.number}`, title: data.title }, 'GitHubIssuesProvider: issue created');
    return this.issueToTicket(issue);
  }

  async getTicket(id: string): Promise<Ticket | null> {
    try {
      const issue = await this.ghFetch<GHIssue>(`/issues/${this.parseId(id)}`);
      return this.issueToTicket(issue);
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async updateTicket(id: string, data: UpdateTicketData, _changedBy?: string): Promise<Ticket> {
    const number = this.parseId(id);
    const existing = await this.getTicket(id);
    if (!existing) throw new Error(`Ticket ${id} not found`);

    const patch: Record<string, unknown> = {};

    if (data.title !== undefined) patch.title = data.title;
    if (data.body !== undefined)  patch.body = data.body;
    if (data.assignee !== undefined) patch.assignees = data.assignee ? [data.assignee] : [];

    // Status change: update state + swap status label
    if (data.status !== undefined) {
      const native = this.statusMapper.toNative(data.status);
      patch.state = native.state;

      // Get current labels, remove old status label, add new one
      const issue = await this.ghFetch<GHIssue>(`/issues/${number}`);
      const currentLabels = issue.labels
        .filter(l => !l.name.startsWith(STATUS_LABEL_PREFIX))
        .map(l => l.name);

      if (native.label) {
        await this.ensureLabel(native.label);
        currentLabels.push(native.label);
      }
      if (data.labels !== undefined) {
        patch.labels = [...data.labels, ...currentLabels.filter(l => !data.labels!.includes(l))];
      } else {
        patch.labels = currentLabels;
      }
    } else if (data.labels !== undefined) {
      const issue = await this.ghFetch<GHIssue>(`/issues/${number}`);
      const statusLabels = issue.labels.filter(l => l.name.startsWith(STATUS_LABEL_PREFIX)).map(l => l.name);
      patch.labels = [...statusLabels, ...data.labels];
    }

    const updated = await this.ghFetch<GHIssue>(`/issues/${number}`, 'PATCH', patch);
    return this.issueToTicket(updated);
  }

  async listTickets(filters: TicketFilters = {}): Promise<Ticket[]> {
    const params = new URLSearchParams({ per_page: '100' });

    if (filters.status) {
      const native = this.statusMapper.toNative(filters.status);
      params.set('state', native.state);
      if (native.label) params.set('labels', native.label);
    } else {
      params.set('state', 'all');
    }

    if (filters.assignee) params.set('assignee', filters.assignee);

    const issues = await this.ghFetch<GHIssue[]>(`/issues?${params}`);
    return issues.map(i => this.issueToTicket(i));
  }

  async addComment(ticketId: string, body: string, _author: string): Promise<TicketComment> {
    const number = this.parseId(ticketId);
    const comment = await this.ghFetch<GHComment>(`/issues/${number}/comments`, 'POST', { body });
    return {
      id: String(comment.id),
      ticketId,
      author: comment.user?.login ?? _author,
      body: comment.body,
      createdAt: comment.created_at,
    };
  }

  async getComments(ticketId: string): Promise<TicketComment[]> {
    const number = this.parseId(ticketId);
    const comments = await this.ghFetch<GHComment[]>(`/issues/${number}/comments`);
    return comments.map(c => ({
      id: String(c.id),
      ticketId,
      author: c.user?.login ?? 'unknown',
      body: c.body,
      createdAt: c.created_at,
    }));
  }

  async deleteTicket(id: string): Promise<void> {
    // GitHub doesn't support deleting issues via API — close it instead
    await this.updateTicket(id, { status: 'done' });
  }
}
