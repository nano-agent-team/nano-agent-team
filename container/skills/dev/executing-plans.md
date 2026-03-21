# Executing Plans

Use this skill at the start of implementation to follow the spec systematically.

## Steps

1. **Read the full spec** — read the entire technical specification before making any changes:
   - Understand the goal and all acceptance criteria
   - Note the files to modify and create
   - Note any constraints or rules

2. **Identify the implementation order** — determine which changes depend on others:
   - Type definitions / interfaces first (other code depends on them)
   - Core logic next
   - Integration / wiring last

3. **Implement one step at a time** — work through the plan sequentially:
   - Complete each file change fully before moving to the next
   - After each file change, verify it compiles/parses correctly if applicable

4. **Check off completed steps** — track progress explicitly:
   - After each step, confirm it is done
   - Note any deviations from the plan and why

5. **Build and test after all steps** — run build and tests only after all changes are in place:
   - `npm run build` (or equivalent)
   - `npm test` (or equivalent)
   - Fix any errors before proceeding

6. **Verify acceptance criteria** — go through each criterion and confirm it is met.

## Rules

- Do not skip steps even if they seem trivial
- If the spec is ambiguous, make a reasonable choice and document it in a comment
- If a step is impossible as written, note it and find the closest correct interpretation
