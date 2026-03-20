# Requesting Code Review

Use this skill when preparing work for review by another agent or team member.

## Steps

1. **Verify the implementation is complete** — before requesting review:
   - Build passes (`npm run build` or equivalent)
   - Tests pass (`npm test` or equivalent)
   - All acceptance criteria are met

2. **Summarise what was done** — write a clear review request:
   - What was implemented (1-3 bullet points)
   - Why the approach was chosen (if non-obvious)
   - Any trade-offs or known limitations

3. **Highlight areas needing attention** — guide the reviewer:
   - Complex logic that deserves scrutiny
   - Areas where you are uncertain
   - Any deviations from the original spec

4. **List files changed** — be explicit:
   - File path and type of change (added / modified / deleted)
   - Brief description of what changed in each file

5. **Specify what kind of feedback you need**:
   - Correctness: does the logic do what it should?
   - Architecture: does the design fit the existing system?
   - Code quality: is the code readable and maintainable?

6. **Publish the review request** — signal via NATS or ticket comment as appropriate.

## Rules

- Never request review on code that does not build or has failing tests
- Be specific about what you want reviewed — "LGTM?" is not a useful review request
- If the change is large, suggest a review order (which files to read first)
