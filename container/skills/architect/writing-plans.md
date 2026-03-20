# Writing Implementation Plans

Use this skill when creating the implementation plan section of a technical spec.

## Steps

1. **List all files that need to change** — be specific:
   - File path (relative to repo root)
   - What changes: add / modify / create / delete
   - Why: brief reason

2. **Identify dependencies between changes** — determine order:
   - Which changes must happen before others? (e.g. type definitions before usage)
   - Group changes into logical phases if needed

3. **Write numbered implementation steps** — ordered and actionable:
   - Each step = one coherent unit of work (one file or one logical change)
   - Step format: `N. **File/component** — what to do and why`
   - Include code snippets for non-obvious changes

4. **Define acceptance criteria** — measurable, checkable:
   - Use GitHub-style checkboxes: `- [ ] criterion`
   - Each criterion must be verifiable (can be checked with a test or manual inspection)
   - Cover the happy path and key edge cases

5. **Specify the test plan** — how to verify the implementation:
   - Unit tests: what to test, which files
   - Integration tests: what scenario to exercise
   - Build verification: `npm run build` / `npm test`

6. **Note risks and constraints** — flag anything that could block developer:
   - External dependencies, environment requirements
   - Areas of uncertainty in the design

## Rules

- Steps must be ordered so a developer can follow them top-to-bottom without re-reading
- No step should be ambiguous — if it requires judgement, specify the judgement criteria
- Acceptance criteria must be independently verifiable (not "looks good")
