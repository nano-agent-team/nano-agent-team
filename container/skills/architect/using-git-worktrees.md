# Using Git Worktrees

Use this skill when working on multiple branches simultaneously or isolating changes.

## Steps

1. **Understand when to use worktrees**:
   - You need to work on branch B while branch A is in review
   - You want to compare two implementations side by side
   - You need an isolated copy of the repo for a risky change

2. **Create a worktree** — linked to a new or existing branch:
   ```bash
   # New branch from current HEAD
   git worktree add ../my-feature-worktree -b feature/my-feature

   # Existing branch
   git worktree add ../hotfix-worktree hotfix/critical-fix
   ```

3. **Work in the worktree** — it is a full working copy:
   ```bash
   cd ../my-feature-worktree
   # make changes, run tests, commit
   ```

4. **Commit in the worktree** — commits go to the linked branch:
   ```bash
   git add -p          # stage selectively
   git commit -m "..."
   ```

5. **Switch back to the main tree** — the main checkout is unaffected:
   ```bash
   cd /workspace/repo
   # original branch still clean
   ```

6. **Remove the worktree when done**:
   ```bash
   git worktree remove ../my-feature-worktree
   # or force-remove if there are uncommitted changes you want to discard:
   git worktree remove --force ../my-feature-worktree
   ```

7. **List active worktrees**:
   ```bash
   git worktree list
   ```

## Rules

- Each branch can only be checked out in one worktree at a time
- Never delete a worktree directory manually — use `git worktree remove`
- Worktrees share the same `.git` object store — commits in one are visible in all
- Clean up worktrees promptly when done to avoid confusion
