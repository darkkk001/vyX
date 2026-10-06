#!/usr/bin/env bash
# Stage 6 gate: the split harness over every variant and seeds 1-3, then the WEB-fallback drill on seeds 1-3.
#
#   bash scripts/load/run-split-matrix.sh [accounts] [walkers]        (default 100 accounts, 2 walkers)
#
# One line per run; exit 1 if any run failed. Each run is scripts/load/run-split.sh (see its header for what it proves).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
N="${1:-100}"; K="${2:-2}"
FAILED=0
RESULTS=()
run() {
  local label="$1"; shift
  local started=$SECONDS
  if bash scripts/load/run-split.sh "$@" > "/tmp/split-matrix-$$.log" 2>&1; then
    RESULTS+=("PASS  $label  ($((SECONDS - started)) s)  $(grep -h 'split-check\] OK' "/tmp/split-matrix-$$.log" | sed 's/.*OK //' | cut -c1-200)")
  else
    FAILED=1
    RESULTS+=("FAIL  $label  ($((SECONDS - started)) s)")
    cp "/tmp/split-matrix-$$.log" "$ROOT/engine/parity/out/load/FAILED-$(echo "$label" | tr ' /' '__').log"
  fi
  echo "${RESULTS[-1]}"
}
for seed in 1 2 3; do
  for variant in web rust-demo rust-all mixed cross cross-topo; do
    run "seed=$seed variant=$variant" --seed "$seed" --accounts "$N" --walkers "$K" --variant "$variant"
  done
done
for seed in 1 2 3; do
  run "seed=$seed DRILL rust-all -> WEB mid-run" --seed "$seed" --accounts "$((N + 50))" --walkers "$K" --variant rust-all --drill
done
echo
printf '%s\n' "${RESULTS[@]}"
exit $FAILED
