#!/usr/bin/env bash
# Stops everything engine/scripts/staging-up.sh started, via the PID
# files it wrote to .staging/. Safe to run even if nothing (or only
# some of it) is actually running.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.staging"

stop_by_pidfile() {
  local name="$1"
  local pidfile="$STATE_DIR/$2"
  if [ ! -f "$pidfile" ]; then
    echo "$name: no pid file, nothing to stop."
    return
  fi
  local pid
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    echo "$name: stopped (pid $pid)."
  else
    echo "$name: pid $pid not running (already stopped)."
  fi
  rm -f "$pidfile"
}

echo "=== Staging environment: shutting down ==="
stop_by_pidfile "parallel-run monitor" "parallel-run.pid"
stop_by_pidfile "engine/server" "server.pid"
stop_by_pidfile "nats-server" "nats.pid"
echo "Done. Logs and results (parallel-run.jsonl) are left in $STATE_DIR for review."
