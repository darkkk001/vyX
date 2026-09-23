#!/usr/bin/env bash
# Stage 4 load harness (docs/RUST-CUTOVER-PLAN.md §4): one seeded world, the web reference run on vyx_load_web, the
# engine run (K concurrent walkers + the real dispatcher into the real route) on vyx_load_engine, then the diff.
#
#   bash scripts/load/run.sh --seed 1 --accounts 100 --walkers 2
#
# Scratch ONLY: 127.0.0.1:5499, databases vyx_load_web / vyx_load_engine (created + migrated if missing). Every
# script re-checks the database it is connected to before writing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SEED=1; N=100; K=2
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEED=$2; shift 2 ;;
    --accounts) N=$2; shift 2 ;;
    --walkers) K=$2; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
PSQL=/d/pg-scratch/pgsql/bin/psql.exe
BASE=postgresql://postgres@127.0.0.1:5499
WEB=$BASE/vyx_load_web
ENG=$BASE/vyx_load_engine
OUT="$ROOT/engine/parity/out/load/s$SEED-n$N-k$K"
mkdir -p "$OUT"
cd "$ROOT"

$PSQL -h 127.0.0.1 -p 5499 -U postgres -Atc "select 1" >/dev/null || { echo "[load] scratch Postgres not reachable"; exit 2; }
for db in vyx_load_web vyx_load_engine; do
  if [ -z "$($PSQL -h 127.0.0.1 -p 5499 -U postgres -Atc "select 1 from pg_database where datname='$db'")" ]; then
    # cloned from the parity harness DB (already migrated): a FRESH database cannot take `migrate deploy`, because
    # 20260921160000_stage3a_group_the_ungrouped is a production data migration that aborts when its listed
    # accounts are missing (a self-hosted installer must handle this -- see the Model B assessment)
    $PSQL -h 127.0.0.1 -p 5499 -U postgres -Atc "create database $db template vyx_rust_harness" >/dev/null
    echo "[load] created $db (from vyx_rust_harness)"
  fi
  DATABASE_URL=$BASE/$db DIRECT_URL=$BASE/$db npx prisma migrate deploy >/dev/null 2>&1 || { echo "[load] migrate deploy failed on $db"; exit 2; }
done

TSX="npx tsx --conditions=react-server"
$TSX scripts/load/generate.ts --seed "$SEED" --accounts "$N" --out "$OUT/world.json"

# ---- web reference
DATABASE_URL=$WEB DIRECT_URL=$WEB $TSX scripts/load/seed.ts "$OUT/world.json"
DATABASE_URL=$WEB DIRECT_URL=$WEB $TSX scripts/load/run-web.ts "$OUT/web-report.json"
DATABASE_URL=$WEB DIRECT_URL=$WEB $TSX scripts/load/snapshot.ts "$OUT/web-snapshot.json"

# ---- engine
DATABASE_URL=$ENG DIRECT_URL=$ENG $TSX scripts/load/seed.ts "$OUT/world.json"
(cd engine && cargo build -q -p parity)
PC_PORT=5592
PC_SECRET="load-$(date +%s)-$RANDOM"
if (exec 3<>/dev/tcp/127.0.0.1/$PC_PORT) 2>/dev/null; then echo "[load] port $PC_PORT busy"; exit 2; fi
DATABASE_URL=$ENG DIRECT_URL=$ENG POST_CLOSE_SECRET=$PC_SECRET PARITY_POST_CLOSE_PORT=$PC_PORT POST_CLOSE_FAIL_POSITIONS="${POST_CLOSE_FAIL_POSITIONS:-}" \
  $TSX scripts/parity/post-close-server.ts > "$OUT/post-close-server.log" 2>&1 &
PC_PID=$!
stop_pc_server() {
  kill $PC_PID 2>/dev/null || true
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $PC_PORT -State Listen -ErrorAction SilentlyContinue | ForEach-Object { \$p = Get-Process -Id \$_.OwningProcess; if (\$p.ProcessName -eq 'node') { Stop-Process -Id \$p.Id -Force } }" >/dev/null 2>&1 || true
  fi
}
trap stop_pc_server EXIT
for _ in $(seq 1 60); do
  grep -q "listening" "$OUT/post-close-server.log" 2>/dev/null && break
  kill -0 $PC_PID 2>/dev/null || { cat "$OUT/post-close-server.log"; echo "[load] post-close server died"; exit 2; }
  sleep 1
done
grep -q "listening" "$OUT/post-close-server.log" || { echo "[load] post-close server did not start"; exit 2; }
VYX_POST_CLOSE_URL="http://127.0.0.1:$PC_PORT/api/internal/post-close" VYX_POST_CLOSE_SECRET=$PC_SECRET VYX_POST_CLOSE_SWEEP_SECS=1 \
  engine/target/debug/parity.exe --load-run "$K" "$OUT/engine-report.json" || echo "[load] engine run exited non-zero"
stop_pc_server
DATABASE_URL=$ENG DIRECT_URL=$ENG $TSX scripts/load/snapshot.ts "$OUT/engine-snapshot.json"

# ---- compare
node scripts/load/diff.mjs "$OUT/world.json" "$OUT/web-snapshot.json" "$OUT/engine-snapshot.json" | tee "$OUT/diff.txt"
