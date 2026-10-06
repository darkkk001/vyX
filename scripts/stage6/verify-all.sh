#!/usr/bin/env bash
# Stage 6 verification, everything the owner asked for in one sequential run (scratch databases only). One line per gate.
#
#   bash scripts/stage6/verify-all.sh [outdir]
#
#   1 cargo test, all crates (scripts/test-engine.sh: full log kept, failures re-run alone, REAL vs FLAKE)
#   2 parity run-db.sh (the Stage 1-5 gate on the real monitor against the real schema)
#   3 shadow-gate.sh (the shadow beside the web)
#   4 scripts/load/run.sh seeds 1-3 (the Stage 4 engine-only load gate, unchanged behaviour)
#   5 scripts/load/run-split-matrix.sh (this stage: every ownership variant x seeds 1-3 + the WEB-fallback drill x 3)
#   6 post-close gate (lib/post-close.test.ts on the harness DB)
#   7 web: full vitest (REDIS_URL set), tsc --noEmit
#   8 mutation check (the proofs fail when their safeguard is broken)
# `npm run build` is run separately (it is long and writes .next).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="${1:-/tmp/stage6-verify}"
mkdir -p "$OUT"
B=postgresql://postgres@127.0.0.1:5499
FAIL=0
gate() { # name, log, command...
  local name="$1" log="$OUT/$2"; shift 2
  local t=$SECONDS
  if "$@" > "$log" 2>&1; then echo "PASS  $name  ($((SECONDS - t)) s)  log: $log"; else echo "FAIL  $name  ($((SECONDS - t)) s)  log: $log"; FAIL=1; fi
}
gate "1 cargo test (all crates)" engine-tests.log bash scripts/test-engine.sh
gate "2 parity run-db.sh" parity-db.log bash scripts/parity/run-db.sh
gate "3 shadow-gate.sh" shadow-gate.log bash scripts/load/shadow-gate.sh
for seed in 1 2 3; do gate "4 load run.sh seed $seed (100 accounts, 2 walkers)" load-seed$seed.log bash scripts/load/run.sh --seed $seed --accounts 100 --walkers 2; done
gate "5 split matrix (21 runs)" split-matrix.log bash scripts/load/run-split-matrix.sh 100 2
H=$B/vyx_rust_harness
gate "6 post-close gate" post-close.log env VYX_TEST_SHARED_DB=1 DATABASE_URL=$H DIRECT_URL=$H POST_CLOSE_GATE=1 REDIS_URL=redis://localhost:6379 npx vitest run lib/post-close.test.ts
gate "7a web vitest (full)" vitest.log env DATABASE_URL=$B/vyx_test DIRECT_URL=$B/vyx_test REDIS_URL=redis://localhost:6379 npx vitest run
gate "7b tsc --noEmit" tsc.log npx tsc --noEmit
gate "8 mutation check" mutation.log bash scripts/stage6/mutation-check.sh
exit $FAIL
