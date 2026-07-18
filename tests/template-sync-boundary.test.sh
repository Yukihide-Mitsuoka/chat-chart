#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.." || exit 9

pass=0
fail=0

expect_rule() {
  rule="$1"
  if grep -qxF "$rule" .templatesyncignore; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: .templatesyncignore is missing required rule: $rule"
  fi
}

expect_rule '.github/workflows/**'
expect_rule 'docs/**'
expect_rule ':!docs/foundation/'
expect_rule ':!docs/foundation/**'

echo "template-sync-boundary.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
