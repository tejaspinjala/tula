#!/usr/bin/env bash
# Runs the store/lock/chain tests (including the multi-process concurrency tests) N times in a row.
# Usage: tests/run-repeat.sh [N=20] [path=tests/unit/lib]. Exits non-zero on the first failing run.
set -u
n="${1:-20}"
target="${2:-tests/unit/lib}"
cd "$(dirname "$0")/.."
for i in $(seq 1 "$n"); do
  if ! out="$(bun test "$target" 2>&1)"; then
    printf '%s\n' "$out"
    echo "run $i/$n FAILED"
    exit 1
  fi
  echo "run $i/$n ok: $(printf '%s\n' "$out" | grep -E '^ *[0-9]+ pass' | tr -s ' ')"
done
echo "all $n runs passed"
