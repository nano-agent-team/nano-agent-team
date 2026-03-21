/**
 * WorkspaceProvider — manages git worktrees as on-demand isolated workspaces.
 *
 * Each ticket gets its own worktree from a bare repo clone.
 *
 * Storage layout:
 *   baseDir/
 *     repos/           # bare repos ({repoType}.git)
 *     active/          # checked-out worktrees (ws-{nanoid})
 *     index.json       # workspaceId → metadata
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import { logger } from './logger.js';

export interface WorkspaceMetadata {
  workspaceId: string;
  path: string;
  repoType: string;
  branch: string;
  ownerId: string;
  status: 'checked-out' | 'returned';
  createdAt: string;
}

export class WorkspaceProvider {
  private readonly baseDir: string;
  private readonly reposDir: string;
  private readonly activeDir: string;
  private readonly indexPath: string;
  private readonly repoUrls: Record<string, string>;
  private index: Record<string, WorkspaceMetadata>;
  private fetchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(baseDir: string, repoUrls: Record<string, string>) {
    this.baseDir = baseDir;
    this.reposDir = path.join(baseDir, 'repos');
    this.activeDir = path.join(baseDir, 'active');
    this.indexPath = path.join(baseDir, 'index.json');
    this.repoUrls = repoUrls;

    // Ensure directories exist
    fs.mkdirSync(this.reposDir, { recursive: true });
    fs.mkdirSync(this.activeDir, { recursive: true });

    // Load existing index
    this.index = this.loadIndex();
  }

  /**
   * Create a new worktree workspace for a ticket/owner.
   */
  async create(repoType: string, ownerId: string, branch?: string): Promise<WorkspaceMetadata> {
    const url = this.repoUrls[repoType];
    if (!url) {
      throw new Error(`Unknown repo type: "${repoType}". Available: ${Object.keys(this.repoUrls).join(', ')}`);
    }

    const bareRepoPath = this.ensureBareRepo(repoType, url);
    const branchName = branch ?? `feat/${ownerId}`;
    const workspaceId = `ws-${nanoid(12)}`;
    const worktreePath = path.join(this.activeDir, workspaceId);

    // Create worktree with a new feature branch off main
    try {
      this.git(bareRepoPath, `worktree add ${worktreePath} -b ${branchName} main`);
    } catch (err) {
      logger.error({ err, repoType, ownerId, branchName }, 'Failed to create worktree');
      throw err;
    }

    const metadata: WorkspaceMetadata = {
      workspaceId,
      path: worktreePath,
      repoType,
      branch: branchName,
      ownerId,
      status: 'checked-out',
      createdAt: new Date().toISOString(),
    };

    this.index[workspaceId] = metadata;
    this.saveIndex();

    logger.info({ workspaceId, repoType, ownerId, branch: branchName }, 'Workspace created');
    return metadata;
  }

  /**
   * Get workspace metadata by ID.
   */
  get(workspaceId: string): WorkspaceMetadata | undefined {
    return this.index[workspaceId];
  }

  /**
   * Find the active (checked-out) workspace for an owner.
   */
  findByOwner(ownerId: string): WorkspaceMetadata | undefined {
    return Object.values(this.index).find(
      (ws) => ws.ownerId === ownerId && ws.status === 'checked-out',
    );
  }

  /**
   * List all workspaces (active and returned).
   */
  list(): WorkspaceMetadata[] {
    return Object.values(this.index);
  }

  /**
   * Return a workspace — removes the worktree and optionally deletes the branch.
   * Branch is deleted only if it has been merged into main.
   */
  returnWorkspace(workspaceId: string): void {
    const ws = this.index[workspaceId];
    if (!ws) {
      logger.warn({ workspaceId }, 'returnWorkspace: unknown workspace');
      return;
    }

    const bareRepoPath = this.barePath(ws.repoType);

    // Remove the worktree
    try {
      this.git(bareRepoPath, `worktree remove --force ${ws.path}`);
    } catch (err) {
      logger.warn({ err, workspaceId }, 'worktree remove failed, cleaning up manually');
      fs.rmSync(ws.path, { recursive: true, force: true });
      // Also prune worktree references
      try {
        this.git(bareRepoPath, 'worktree prune');
      } catch { /* best effort */ }
    }

    // Delete branch only if merged into main
    try {
      const merged = this.git(bareRepoPath, 'branch --merged main');
      const mergedBranches = merged.split('\n').map((b) => b.trim().replace(/^\* /, ''));
      if (mergedBranches.includes(ws.branch)) {
        this.git(bareRepoPath, `branch -d ${ws.branch}`);
        logger.info({ workspaceId, branch: ws.branch }, 'Branch deleted (was merged)');
      } else {
        logger.info({ workspaceId, branch: ws.branch }, 'Branch kept (not merged)');
      }
    } catch (err) {
      logger.warn({ err, workspaceId }, 'Branch cleanup check failed');
    }

    ws.status = 'returned';
    this.saveIndex();
    logger.info({ workspaceId }, 'Workspace returned');
  }

  /**
   * Start periodic fetch of all bare repos (every 5 minutes).
   */
  startPeriodicFetch(): void {
    if (this.fetchTimer) return;
    this.fetchTimer = setInterval(() => this.fetchAll(), 5 * 60 * 1000);
    // Also fetch immediately
    this.fetchAll();
  }

  /**
   * Stop the periodic fetch timer.
   */
  shutdown(): void {
    if (this.fetchTimer) {
      clearInterval(this.fetchTimer);
      this.fetchTimer = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Ensure a bare repo exists for the given repoType.
   * If the URL is a local path, use it directly. Otherwise, clone --bare.
   */
  private ensureBareRepo(repoType: string, url: string): string {
    const barePath = this.barePath(repoType);

    if (fs.existsSync(barePath)) {
      return barePath;
    }

    // git clone --bare works for local paths (bare or non-bare) and remote URLs
    this.git(this.reposDir, `clone --bare ${url} ${path.basename(barePath)}`);

    // Configure git identity and ensure rc branch exists
    this.configureGitAuth(barePath);
    this.ensureRcBranch(barePath);

    logger.info({ repoType, url, barePath }, 'Bare repo cloned');
    return barePath;
  }

  /**
   * Configure git identity for worktree commits.
   * GitHub push auth deferred to Secret Manager (future).
   */
  private configureGitAuth(bareRepoPath: string): void {
    try {
      this.git(bareRepoPath, 'config user.email "pipeline@nano-agent-team"');
      this.git(bareRepoPath, 'config user.name "Pipeline Agent"');
    } catch { /* best effort */ }
  }

  /** Ensure the rc (release candidate) branch exists in the bare repo, branched from main. */
  private ensureRcBranch(bareRepoPath: string): void {
    try {
      const branches = this.git(bareRepoPath, 'branch');
      if (!branches.includes('rc')) {
        this.git(bareRepoPath, 'branch rc main');
        logger.info({ bareRepoPath }, 'Created rc branch from main');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to create rc branch');
    }
  }

  private barePath(repoType: string): string {
    return path.join(this.reposDir, `${repoType}.git`);
  }

  private fetchAll(): void {
    for (const repoType of Object.keys(this.repoUrls)) {
      const barePath = this.barePath(repoType);
      if (!fs.existsSync(barePath)) continue;

      try {
        this.git(barePath, 'fetch --all --prune');
        logger.debug({ repoType }, 'Fetched bare repo');
      } catch (err) {
        logger.warn({ err, repoType }, 'Failed to fetch bare repo');
      }
    }
  }

  private git(cwd: string, args: string): string {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
    }).trim();
  }

  private loadIndex(): Record<string, WorkspaceMetadata> {
    if (fs.existsSync(this.indexPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
      } catch (err) {
        logger.warn({ err }, 'Failed to load workspace index, starting fresh');
      }
    }
    return {};
  }

  private saveIndex(): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
  }
}
