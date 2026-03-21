# Test-Driven Development (TDD)

Follow this workflow when implementing any feature or fix:

## Steps

1. **Read the spec** — understand the acceptance criteria before writing any code.

2. **Write failing tests first** — before touching implementation code:
   - Identify what functions/modules need to exist
   - Write unit tests that describe the expected behaviour
   - Run tests and confirm they fail (red phase)

3. **Write minimal implementation** — write just enough code to make the tests pass:
   - Do not over-engineer
   - Focus on making the tests green, nothing more

4. **Run tests** — confirm all tests now pass (green phase).

5. **Refactor** — clean up the code while keeping tests green:
   - Remove duplication
   - Improve naming and structure
   - Run tests again after each refactor

6. **Repeat** — for each additional requirement, repeat the red → green → refactor cycle.

## Rules

- Never write implementation before the test
- A test must fail before you write implementation code to pass it
- If you cannot write a test first (e.g. UI rendering), document why and proceed with implementation + test together
- Run the full test suite before signalling done
