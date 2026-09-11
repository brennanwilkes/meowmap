#!/usr/bin/env bash
# All frontend tests. No framework, no dependencies — plain node over the real modules,
# so a test can never drift from what ships.
#   bash tests/run-all.sh
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
for t in tests/*.test.mjs; do
  if ! node "$t"; then fail=1; fi
done
if [ $fail -eq 0 ]; then
  echo "--- all frontend tests passed"
else
  echo "--- FAILURES ABOVE"
fi
exit $fail
