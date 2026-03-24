#!/usr/bin/env bash
# Test: --version flag for agent-runner and deterministic-runner
# Verifies that both runners print the version from their package.json and exit 0.
set -uo pipefail

PASS=0
FAIL=0

assert_version() {
  local name="$1" dir="$2"
  local expected
  expected=$(node -e "console.log(require('./${dir}/package.json').version)")

  local actual exit_code
  actual=$(node "${dir}/dist/index.js" --version 2>/dev/null) && exit_code=$? || exit_code=$?

  if [[ "$exit_code" -ne 0 ]]; then
    echo "FAIL: ${name} --version exited with code ${exit_code} (expected 0)"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: ${name} --version printed '${actual}' (expected '${expected}')"
    FAIL=$((FAIL + 1))
    return
  fi

  echo "PASS: ${name} --version => ${actual}"
  PASS=$((PASS + 1))
}

cd "$(dirname "$0")"

assert_version "agent-runner" "agent-runner"
assert_version "deterministic-runner" "deterministic-runner"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
