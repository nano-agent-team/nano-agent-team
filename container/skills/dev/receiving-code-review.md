# Receiving Code Review

Use this skill when you receive code review feedback (e.g. from `topic.review.feedback`).

## Steps

1. **Read all feedback first** — before making any changes:
   - Read every comment in the review
   - Categorise each as: must-fix, should-fix, or suggestion

2. **Acknowledge the feedback** — understand the reviewer's intent:
   - For each must-fix: understand what is wrong and why
   - For each should-fix: evaluate whether the concern is valid
   - For suggestions: decide whether to apply or note why not

3. **Apply must-fix items** — address all blocking issues first:
   - Fix one item at a time
   - Verify the fix does not break existing tests

4. **Apply should-fix items** — address important but non-blocking issues:
   - Use judgement — if the fix is simple and clearly correct, apply it
   - If you disagree, document your reasoning in a comment

5. **Build and test** — after all changes:
   - `npm run build` — must pass
   - `npm test` — all tests must pass

6. **Respond to the review** — add a ticket comment:
   - List each piece of feedback and what action was taken
   - For anything not addressed, explain why

7. **Signal completion** — publish `topic.dev.done` to trigger re-review.

## Rules

- Never ignore must-fix items
- Never argue with feedback without providing a clear technical reason
- If feedback is unclear, ask for clarification via ticket comment before implementing
