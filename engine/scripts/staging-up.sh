#!/usr/bin/env bash
# Brings up the local pieces of the parallel-run "staging environment"
# (docs/testing.md §4): nats-server + engine/server (the Rust Trading
# Core), then the parallel-run diagnostic in sustained-loop mode,
# writing a reviewable JSON-lines history instead of a one-shot report.
# See docs/testing.md for the full picture, and engine/parallel-run's
# own module doc for what this comparison does and doesn't prove.
#
# Native processes, not Docker (this sandbox has no Docker, and this
# repo has never used it anywhere) -- plain bash + cargo-built binaries,
# which run identically on a Linux VPS later with no rewrite needed.
#
# Does NOT start or manage the Next.js dev server -- too different a
# lifecycle to own reliably here. It only checks NEXTJS_URL is
# reachable and tells you plainly if it isn't.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$SCRIPT_DIR/.staging"
mkdir -p "$STATE_DIR"

: "${DATABASE_URL:?DATABASE_URL must be set (see docs/database.md)}"
# Not security-sensitive for a local staging run -- nothing here
# exercises the MT5-EA price-feed-push endpoint this secret actually
# gates, engine/server just refuses to start without some value set.
: "${PRICE_FEED_SECRET:=staging-local-not-for-production}"
export PRICE_FEED_SECRET
: "${PORT:=8081}"
export PORT
: "${NEXTJS_URL:=http://localhost:3000}"
# Default: check both scenarios every 2 minutes. Override for a
# shorter interval when testing this script itself.
: "${PARALLEL_RUN_LOOP_SECS:=120}"
export PARALLEL_RUN_LOOP_SECS
: "${PARALLEL_RUN_LOG:=$STATE_DIR/parallel-run.jsonl}"
export PARALLEL_RUN_LOG

is_running() {
  local pidfile="$1"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

echo "=== Staging environment: bringing up ==="

if ! curl -sf -o /dev/null --max-time 3 "$NEXTJS_URL"; then
  echo "WARNING: $NEXTJS_URL is not reachable. Start the Next.js dev server" \
       "(npm run dev, from the repo root) first -- the parallel-run monitor's" \
       "Legacy-path comparisons need it running, and will error every" \
       "iteration until it is." >&2
fi

echo "Building release binaries (server, parallel-run)..."
( cd "$ENGINE_DIR" && cargo build --release -p server -p parallel-run )

if is_running "$STATE_DIR/nats.pid"; then
  echo "nats-server already running (pid $(cat "$STATE_DIR/nats.pid"))"
else
  nats-server > "$STATE_DIR/nats.log" 2>&1 &
  echo $! > "$STATE_DIR/nats.pid"
  echo "Started nats-server (pid $(cat "$STATE_DIR/nats.pid"))"
  sleep 1
fi

if is_running "$STATE_DIR/server.pid"; then
  echo "engine/server already running (pid $(cat "$STATE_DIR/server.pid"))"
else
  "$ENGINE_DIR/target/release/trading-core-server" > "$STATE_DIR/server.log" 2>&1 &
  echo $! > "$STATE_DIR/server.pid"
  echo "Starting engine/server (pid $(cat "$STATE_DIR/server.pid")), waiting for /health..."
  ready=0
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  if [ "$ready" -ne 1 ]; then
    echo "engine/server did not become healthy in time -- check $STATE_DIR/server.log" >&2
    exit 1
  fi
  echo "engine/server is healthy."
fi

if is_running "$STATE_DIR/parallel-run.pid"; then
  echo "parallel-run monitor already running (pid $(cat "$STATE_DIR/parallel-run.pid"))"
else
  "$ENGINE_DIR/target/release/parallel-run" > "$STATE_DIR/parallel-run.log" 2>&1 &
  echo $! > "$STATE_DIR/parallel-run.pid"
  echo "Started parallel-run monitor (pid $(cat "$STATE_DIR/parallel-run.pid"))," \
       "interval=${PARALLEL_RUN_LOOP_SECS}s, results log=$PARALLEL_RUN_LOG"
fi

cat <<EOF

Staging environment is up. Useful commands:
  tail -f $STATE_DIR/server.log        # engine/server output
  tail -f $STATE_DIR/parallel-run.log  # parallel-run narration
  tail -f $PARALLEL_RUN_LOG            # structured JSON-lines results
  engine/scripts/staging-down.sh       # stop everything
EOF
