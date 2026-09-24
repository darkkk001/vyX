#!/usr/bin/env bash
# Engine test run that leaves enough behind to identify a failure, flaky or not.
#
#   bash scripts/test-engine.sh            # whole workspace, DB tests on the scratch DB (required)
#   bash scripts/test-engine.sh -p order-management --test outbox_db
#
# - the full cargo output goes to engine/target/test-logs/<UTC time>-<commit>.log (never filtered away);
# - on failure it prints, per failed test: the test binary, the test's name, its panic message (file:line);
# - every failed test is then re-run ALONE once: failing again = REAL, passing = FLAKE (still exit 1, so a flake is
#   never silently green). The run's parameters (commit, threads, DB) head the log so a run can be repeated.
# Scratch DB only: ENGINE_TEST_DATABASE_URL defaults to the local vyx_test and must be 127.0.0.1 / localhost.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/engine"
export ENGINE_TEST_DATABASE_URL="${ENGINE_TEST_DATABASE_URL:-postgresql://postgres@127.0.0.1:5499/vyx_test}"
case "$ENGINE_TEST_DATABASE_URL" in *@127.0.0.1:*|*@localhost:*) ;; *) echo "refusing: ENGINE_TEST_DATABASE_URL is not local"; exit 2 ;; esac
export VYX_REQUIRE_DB_TESTS=1
export RUST_BACKTRACE=1
THREADS="${RUST_TEST_THREADS:-default}"
mkdir -p target/test-logs
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COMMIT="$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"
LOG="target/test-logs/$STAMP-$COMMIT.log"
{
  echo "# engine tests  commit=$COMMIT  utc=$STAMP  threads=$THREADS  db=$ENGINE_TEST_DATABASE_URL  args=${*:-(workspace)}"
} > "$LOG"

if [ $# -gt 0 ]; then
  cargo test "$@" >> "$LOG" 2>&1
else
  cargo test --workspace >> "$LOG" 2>&1
fi
STATUS=$?

TOTALS=$(grep -E "^test result:" "$LOG" | awk '{p+=$4; f+=$6; i+=$8} END {printf "%d passed, %d failed, %d ignored", p, f, i}')
if [ $STATUS -eq 0 ]; then
  echo "[test-engine] OK: $TOTALS  (log: engine/$LOG)"
  exit 0
fi

echo "[test-engine] FAILED: $TOTALS  (log: engine/$LOG)"
# "Running tests/outbox_db.rs (target/debug/deps/outbox_db-<hash>.exe)" gives the source and the exact binary;
# "test some::name ... FAILED" the test
FAILED=$(awk '/^ *Running /{src=$2; exe=$NF; gsub(/[()]/, "", exe)} / \.\.\. FAILED$/{sub(/^test /,""); sub(/ \.\.\. FAILED$/,""); print src "|" exe "|" $0}' "$LOG" | sort -u)
if [ -z "$FAILED" ]; then
  echo "  (no individual test failed: a build error or a test binary crashed -- see the log)"
  grep -nE "^error(\[|:)|could not compile|process didn't exit successfully" "$LOG" | head -10 | sed 's/^/  /'
  exit 1
fi
while IFS='|' read -r SRC EXE NAME; do
  echo "  FAILED  $NAME   ($SRC)"
  # its panic, from the "---- name stdout ----" section
  awk -v n="$NAME" '$0 == "---- " n " stdout ----" {on=1; next} on && /^---- / {exit} on && /panicked at|assertion|left:|right:/ {print "          " $0}' "$LOG" | head -6
done <<< "$FAILED"

echo "[test-engine] re-running each failed test alone (same binary, --exact):"
while IFS='|' read -r SRC EXE NAME; do
  if "$EXE" --exact "$NAME" >> "$LOG.rerun" 2>&1; then
    echo "  FLAKE   $NAME   (failed in the full run, passed alone -- log: engine/$LOG.rerun)"
  else
    echo "  REAL    $NAME   (fails alone too -- log: engine/$LOG.rerun)"
  fi
done <<< "$FAILED"
exit 1
