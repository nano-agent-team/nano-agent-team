# Systematic Debugging

Use this methodology when a test fails after 2+ attempts and you cannot identify the root cause.

## Steps

1. **Reproduce reliably** — confirm the failure is consistent:
   - Run the failing test in isolation
   - Note the exact error message and stack trace

2. **Read the error carefully** — do not guess:
   - What type of error is it? (TypeError, AssertionError, timeout, etc.)
   - What line/function is failing?
   - What value was expected vs actual?

3. **Form a hypothesis** — state one specific cause:
   - "I think the issue is X because Y"
   - Write the hypothesis down before acting on it

4. **Add instrumentation** — insert logging/assertions to verify the hypothesis:
   - Log inputs and outputs around the failing code
   - Use `console.log` or language-equivalent temporarily

5. **Test the hypothesis** — run the test and observe output:
   - If hypothesis is confirmed → fix the issue
   - If hypothesis is wrong → cross it out and form a new one

6. **Fix and verify** — apply the minimal fix:
   - Run the specific failing test
   - Run the full test suite to check for regressions

7. **Clean up** — remove temporary logging before committing.

## Rules

- Only one hypothesis at a time — do not fix multiple things simultaneously
- Never change code "to see what happens" without a hypothesis
- If stuck after 3 hypotheses → read the relevant source code top-to-bottom before continuing
