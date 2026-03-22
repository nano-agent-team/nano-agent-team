import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceProvider } from '../workspace-provider.js';

/**
 * Integration tests for WorkspaceProvider.
 *
 * Sets up a real local bare repo so we can test worktree operations
 * without any network access.
 */

let tmpDir: string;
let bareRepoPath: string;
let providerBaseDir: string;

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' } }).trim();
}

beforeAll(() => {
  // Create temp directory structure
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-provider-test-'));
  bareRepoPath = path.join(tmpDir, 'origin.git');
  const cloneDir = path.join(tmpDir, 'clone');

  // Create bare repo
  fs.mkdirSync(bareRepoPath);
  git(bareRepoPath, 'init --bare --initial-branch=main');

  // Clone, add a commit, push
  git(tmpDir, `clone ${bareRepoPath} clone`);
  fs.writeFileSync(path.join(cloneDir, 'README.md'), '# Test repo\n');
  git(cloneDir, 'add .');
  git(cloneDir, 'commit -m "initial commit"');
  git(cloneDir, 'push origin HEAD:main');

  // Clean up the clone — we only need the bare repo
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WorkspaceProvider', () => {
  let provider: WorkspaceProvider;

  beforeEach(() => {
    providerBaseDir = path.join(tmpDir, `provider-${Date.now()}`);
    provider = new WorkspaceProvider(providerBaseDir, {
      'test-repo': bareRepoPath,
    });
  });

  afterEach(() => {
    provider.shutdown();
  });

  it('creates a worktree workspace with correct metadata', async () => {
    const ws = await provider.create('test-repo', 'TICK-001');

    expect(ws.workspaceId).toMatch(/^ws-/);
    expect(ws.repoType).toBe('test-repo');
    expect(ws.branch).toBe('feat/TICK-001');
    expect(ws.ownerId).toBe('TICK-001');
    expect(ws.status).toBe('checked-out');
    expect(ws.createdAt).toBeTruthy();

    // Verify the worktree directory exists and has files
    expect(fs.existsSync(ws.path)).toBe(true);
    expect(fs.existsSync(path.join(ws.path, 'README.md'))).toBe(true);
  });

  it('creates a worktree with custom branch name', async () => {
    const ws = await provider.create('test-repo', 'TICK-002', 'fix/TICK-002');

    expect(ws.branch).toBe('fix/TICK-002');
    expect(fs.existsSync(ws.path)).toBe(true);
  });

  it('finds workspace by owner', async () => {
    const ws = await provider.create('test-repo', 'TICK-003');

    const found = provider.findByOwner('TICK-003');
    expect(found).toBeDefined();
    expect(found!.workspaceId).toBe(ws.workspaceId);
  });

  it('returns undefined for unknown owner', () => {
    const found = provider.findByOwner('TICK-UNKNOWN');
    expect(found).toBeUndefined();
  });

  it('lists all workspaces', async () => {
    await provider.create('test-repo', 'TICK-010');
    await provider.create('test-repo', 'TICK-011');

    const all = provider.list();
    expect(all.length).toBe(2);
  });

  it('returns workspace and cleans up', async () => {
    const ws = await provider.create('test-repo', 'TICK-020');
    const wsPath = ws.path;

    expect(fs.existsSync(wsPath)).toBe(true);

    provider.returnWorkspace(ws.workspaceId);

    // Directory should be removed
    expect(fs.existsSync(wsPath)).toBe(false);

    // Metadata should be updated
    const meta = provider.get(ws.workspaceId);
    expect(meta).toBeDefined();
    expect(meta!.status).toBe('returned');

    // Should not appear in findByOwner
    expect(provider.findByOwner('TICK-020')).toBeUndefined();
  });

  it('throws on unknown repoType', async () => {
    await expect(provider.create('nonexistent-repo', 'TICK-099'))
      .rejects.toThrow(/unknown.*repo.*type/i);
  });

  it('persists index to disk and reloads', async () => {
    const ws = await provider.create('test-repo', 'TICK-030');
    provider.shutdown();

    // Create a new provider pointing at the same baseDir
    const provider2 = new WorkspaceProvider(providerBaseDir, {
      'test-repo': bareRepoPath,
    });

    const loaded = provider2.get(ws.workspaceId);
    expect(loaded).toBeDefined();
    expect(loaded!.ownerId).toBe('TICK-030');

    provider2.shutdown();
  });

  it('get returns undefined for unknown workspaceId', () => {
    expect(provider.get('ws-nonexistent')).toBeUndefined();
  });
});
