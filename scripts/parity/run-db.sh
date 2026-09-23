#!/usr/bin/env bash
# Stage 1 gate: the web path vs the engine's REAL monitor on the REAL schema (scratch DB only).
# For each scenario: the web run (run-ts.ts, out/ts) as in run-all.sh, then the scenario is re-seeded and
# `cargo run -p parity -- --db` runs order_management::monitor::evaluate_account over book.rs (out/rust-db).
# See engine/parity/README.md. Uses ONLY 127.0.0.1:5499/vyx_rust_harness.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL=postgresql://postgres@127.0.0.1:5499/vyx_rust_harness
case "$URL" in postgresql://postgres@127.0.0.1:5499/*) ;; *) echo "refusing: not the scratch DB"; exit 2 ;; esac
cd "$ROOT"
DATABASE_URL=$URL DIRECT_URL=$URL npx tsx --conditions=react-server scripts/parity/run-ts.ts
(cd engine && cargo build -q -p parity)

# Stage 4.5: the engine's post-close follow-up runs through the real dispatcher into the web's real route, served
# locally on the scratch DB (scripts/parity/post-close-server.ts); stopped on exit.
PC_PORT=5591
if (exec 3<>/dev/tcp/127.0.0.1/$PC_PORT) 2>/dev/null; then echo "[parity] port $PC_PORT is busy (a previous post-close server?)"; exit 2; fi
PC_SECRET="parity-$(date +%s)-$RANDOM"
DATABASE_URL=$URL DIRECT_URL=$URL POST_CLOSE_SECRET=$PC_SECRET PARITY_POST_CLOSE_PORT=$PC_PORT   npx tsx --conditions=react-server scripts/parity/post-close-server.ts > engine/parity/out/post-close-server.log 2>&1 &
PC_PID=$!
# npx/tsx run the server in a child node process: on Windows killing $PC_PID alone leaves it listening, so stop
# whatever node process holds the port (the one this script started)
stop_pc_server() {
  kill $PC_PID 2>/dev/null || true
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $PC_PORT -State Listen -ErrorAction SilentlyContinue | ForEach-Object { \$p = Get-Process -Id \$_.OwningProcess; if (\$p.ProcessName -eq 'node') { Stop-Process -Id \$p.Id -Force } }" >/dev/null 2>&1 || true
  fi
}
trap stop_pc_server EXIT
for _ in $(seq 1 60); do
  grep -q "listening" engine/parity/out/post-close-server.log 2>/dev/null && break
  kill -0 $PC_PID 2>/dev/null || { cat engine/parity/out/post-close-server.log; echo "[parity] post-close server died"; exit 2; }
  sleep 1
done
grep -q "listening" engine/parity/out/post-close-server.log || { echo "[parity] post-close server did not start"; exit 2; }
export VYX_POST_CLOSE_URL="http://127.0.0.1:$PC_PORT/api/internal/post-close"
export VYX_POST_CLOSE_SECRET=$PC_SECRET
for f in engine/parity/scenarios/*.json; do
  name="$(basename "$f" .json)"
  PARITY_SEED_ONLY=1 DATABASE_URL=$URL DIRECT_URL=$URL npx tsx --conditions=react-server scripts/parity/run-ts.ts "$name"
  (cd engine && cargo run -q -p parity -- --db "$name")
done
node scripts/parity/diff.mjs --rust-dir rust-db "$@"
