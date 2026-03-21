# Verification Before Completion

Run this checklist before publishing `topic.dev.done` or signalling implementation complete.

## Checklist

### 1. Build passes
- [ ] Run `npm run build` (or equivalent) — zero errors, zero warnings if possible

### 2. Tests pass
- [ ] Run `npm test` (or equivalent) — all tests green
- [ ] No tests skipped without justification

### 3. Acceptance criteria met
- [ ] Go through each acceptance criterion in the spec
- [ ] Confirm each is implemented and verifiable

### 4. Code quality
- [ ] No debug logging left in (`console.log`, `print`, etc.)
- [ ] No commented-out code blocks left behind
- [ ] No TODO/FIXME comments unless they were pre-existing

### 5. Files changed match the spec
- [ ] Only the files described in the spec were changed (no unrelated edits)
- [ ] No sensitive files changed (`.env`, credentials, etc.)

### 6. Comment with summary
- [ ] Add a ticket comment summarising what was implemented and test results

## If any check fails

Fix the issue before signalling done. Do not signal `topic.dev.done` with failing tests or build errors.
