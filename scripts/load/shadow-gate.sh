#!/usr/bin/env bash
# Stage 5 scratch gate (docs/RUST-CUTOVER-PLAN.md §5.5): the engine in SHADOW mode reads the same database the web
# acts on, at the same time; the reconciler must find zero VALUE / ENGINE_ONLY / WEB_ONLY.
#
#   bash scripts/load/shadow-gate.sh --seed 1 --accounts 100
#
# Scratch ONLY: 127.0.0.1:5499, database vyx_load_web (created by scripts/load/run.sh the first time). Re-seeded.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SEED=1; N=100
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEED=$2; shift 2 ;;
    --accounts) N=$2; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
PSQL=/d/pg-scratch/pgsql/bin/psql.exe
WEB=postgresql://postgres@127.0.0.1:5499/vyx_load_web
OUT="$ROOT/engine/parity/out/shadow/s$SEED-n$N"
mkdir -p "$OUT"
cd "$ROOT"
$PSQL -h 127.0.0.1 -p 5499 -U postgres -Atc "select 1 from pg_database where datname='vyx_load_web'" | grep -q 1 || { echo "[shadow-gate] vyx_load_web missing: run scripts/load/run.sh once"; exit 2; }

# Stage 5 guard 1: the shadow reads the book as a read-only role (engine/order-management/src/shadow.rs
# connect_read_only_book refuses a role that can write a money table)
# ... created by the PRODUCTION grant file itself, so the gate proves those exact (least-privilege) grants suffice
$PSQL -h 127.0.0.1 -p 5499 -U postgres -d vyx_load_web -q -v ON_ERROR_STOP=1 -v shadow_pw=scratch -f deploy/neon-shadow-readonly.sql
export VYX_SHADOW_DATABASE_URL=postgresql://vyx_shadow_ro@127.0.0.1:5499/vyx_load_web

TSX="npx tsx --conditions=react-server"
$TSX scripts/load/generate.ts --seed "$SEED" --accounts "$N" --out "$OUT/world.json"
DATABASE_URL=$WEB DIRECT_URL=$WEB $TSX scripts/load/seed.ts "$OUT/world.json"

(cd engine && cargo build -q -p parity)
STOP="$OUT/stop"; rm -f "$STOP"
engine/target/debug/parity.exe --shadow-run "$STOP" "$OUT/shadow-report.json" > "$OUT/shadow.log" 2>&1 &
SH_PID=$!
for _ in $(seq 1 60); do
  grep -q "shadow ready" "$OUT/shadow.log" 2>/dev/null && break
  kill -0 $SH_PID 2>/dev/null || { cat "$OUT/shadow.log"; echo "[shadow-gate] shadow died"; exit 2; }
  sleep 1
done

# the web acts on the same book while the shadow watches
DATABASE_URL=$WEB DIRECT_URL=$WEB $TSX scripts/load/run-web.ts "$OUT/web-report.json"
touch "$STOP"
set +e
wait $SH_PID
CODE=$?
set -e
grep "\[shadow-gate\]" "$OUT/shadow.log" | tail -30
if [ $CODE -ne 0 ]; then
  echo "[shadow-gate] FAILED seed=$SEED accounts=$N commit=$(git rev-parse --short HEAD) out=$OUT"
  exit 1
fi
echo "[shadow-gate] GREEN seed=$SEED accounts=$N"
