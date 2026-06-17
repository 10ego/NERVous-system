#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
for p in magi axon synapse cortex lion cerebel ganglion amygdala; do
  (cd "$p" && npx tsc --noEmit >/tmp/nervous-$p-tsc.log 2>&1) || { echo "Typecheck failed in $p"; tail -80 /tmp/nervous-$p-tsc.log; exit 1; }
done
npx vitest run >/tmp/nervous-vitest.log 2>&1 || { echo "Vitest failed"; tail -120 /tmp/nervous-vitest.log; exit 1; }
tail -20 /tmp/nervous-vitest.log
