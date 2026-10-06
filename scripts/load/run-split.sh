#!/usr/bin/env bash
# Stage 6 split harness (docs/STAGE6-PLAN.md, "the split proof" and "the WEB-fallback drill"): ONE seeded world, the web reference
# run alone on vyx_load_web (every broker WEB, the web's id-ordered walk), and then the SAME world on vyx_load_split, where the
# web runner and the engine's K walkers run AT THE SAME TIME on the one database, each acting only on the accounts the rule gives
# it (broker flags + account modes from scripts/load/split.ts). Then:
#   - the end state must equal the web reference, id by id (scripts/load/diff.mjs): nothing missed, nothing done twice, nothing
#     different, whichever side did it;
#   - exactly-once (scripts/load/exactly-once.ts): one TRADE_PNL per position, every outbox row DONE once;
#   - attribution (scripts/load/split-check.ts): every action traced by its actor is on an account that actor owns, no position
#     was closed by two actions, every risk-closed position has exactly one action.
#
#   bash scripts/load/run-split.sh --seed 1 --accounts 100 --walkers 2 --variant mixed
#   bash scripts/load/run-split.sh --seed 1 --accounts 150 --walkers 2 --variant rust-all --drill     # WEB-fallback drill
#
# variants: web | rust-demo | rust-all | mixed | cross | cross-topo   (scripts/load/split.ts; cross-topo checks invariants only)
# --drill: variant must be rust-all. After the engine's first closes the brokers are flipped RUST -> WEB with one UPDATE (the
#   runbook's SQL) in the middle of the run; the web takes over the rest. Checked on top: every engine close started before the
#   flip, every web action came after it, both sides worked, and the end state still equals the web reference.
# Scratch ONLY: 127.0.0.1:5499, vyx_load_web / vyx_load_split.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SEED=1; N=100; K=2; VARIANT=mixed; DRILL=0; DRILL_AFTER=10
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEED=$2; shift 2 ;;
    --accounts) N=$2; shift 2 ;;
    --walkers) K=$2; shift 2 ;;
    --variant) VARIANT=$2; shift 2 ;;
    --drill) DRILL=1; shift ;;
    --drill-after) DRILL_AFTER=$2; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
if [ "$DRILL" = 1 ] && [ "$VARIANT" != "rust-all" ]; then echo "--drill needs --variant rust-all"; exit 2; fi
PSQL=/d/pg-scratch/pgsql/bin/psql.exe
PG="$PSQL -h 127.0.0.1 -p 5499 -U postgres -Atq"
BASE=postgresql://postgres@127.0.0.1:5499
WEB=$BASE/vyx_load_web
SPLIT=$BASE/vyx_load_split
TAG="$VARIANT$(if [ "$DRILL" = 1 ]; then echo -drill; fi)-s$SEED-n$N-k$K"
OUT="$ROOT/engine/parity/out/load/split-$TAG"
rm -rf "$OUT"; mkdir -p "$OUT"
cd "$ROOT"
unset MSYS_NO_PATHCONV

$PG -c "select 1" >/dev/null || { echo "[split] scratch Postgres not reachable"; exit 2; }
for db in vyx_load_web vyx_load_split; do
  if [ -z "$($PG -c "select 1 from pg_database where datname='$db'")" ]; then
    $PG -c "create database $db template vyx_rust_harness" >/dev/null
    echo "[split] created $db (from vyx_rust_harness)"
  fi
  DATABASE_URL=$BASE/$db DIRECT_URL=$BASE/$db npx prisma migrate deploy >/dev/null 2>&1 || { echo "[split] migrate deploy failed on $db"; exit 2; }
done

TSX="npx tsx --conditions=react-server"
$TSX scripts/load/generate.ts --seed "$SEED" --accounts "$N" --out "$OUT/world.json" >/dev/null

# ---- the web reference (every broker WEB, one runner, id order): what the end state must be
DATABASE_URL=$WEB DIRECT_URL=$WEB $TSX scripts/load/seed.ts "$OUT/world.json" >/dev/null
DATABASE_URL=$WEB DIRECT_URL=$WEB $TSX scripts/load/run-web.ts "$OUT/web-report.json" >/dev/null
DATABASE_URL=$WEB DIRECT_URL=$WEB $TSX scripts/load/snapshot.ts "$OUT/web-snapshot.json" >/dev/null

# ---- the split world
DATABASE_URL=$SPLIT DIRECT_URL=$SPLIT LOAD_SPLIT=$VARIANT $TSX scripts/load/seed.ts "$OUT/world.json" | tail -1
(cd engine && cargo build -q -p parity)
PC_PORT=5593
PC_SECRET="split-$(date +%s)-$RANDOM"
if (exec 3<>/dev/tcp/127.0.0.1/$PC_PORT) 2>/dev/null; then echo "[split] port $PC_PORT busy"; exit 2; fi
DATABASE_URL=$SPLIT DIRECT_URL=$SPLIT POST_CLOSE_SECRET=$PC_SECRET PARITY_POST_CLOSE_PORT=$PC_PORT $TSX scripts/parity/post-close-server.ts > "$OUT/post-close-server.log" 2>&1 &
PC_PID=$!
WEB_PID=""
stop_all() {
  kill $PC_PID 2>/dev/null || true
  [ -n "$WEB_PID" ] && kill $WEB_PID 2>/dev/null || true
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $PC_PORT -State Listen -ErrorAction SilentlyContinue | ForEach-Object { \$p = Get-Process -Id \$_.OwningProcess; if (\$p.ProcessName -eq 'node') { Stop-Process -Id \$p.Id -Force } }" >/dev/null 2>&1 || true
  fi
}
trap stop_all EXIT
for _ in $(seq 1 60); do
  grep -q "listening" "$OUT/post-close-server.log" 2>/dev/null && break
  kill -0 $PC_PID 2>/dev/null || { cat "$OUT/post-close-server.log"; echo "[split] post-close server died"; exit 2; }
  sleep 1
done
grep -q "listening" "$OUT/post-close-server.log" || { echo "[split] post-close server did not start"; exit 2; }

WEB_TRACE="$OUT/web-trace.jsonl"; ENG_TRACE="$OUT/engine-trace.jsonl"; STOP="$OUT/web.stop"
: > "$WEB_TRACE"; : > "$ENG_TRACE"
DATABASE_URL=$SPLIT DIRECT_URL=$SPLIT VYX_RISK_ACTION_TRACE="$WEB_TRACE" LOAD_WEB_STOP_FILE="$STOP" $TSX scripts/load/run-web.ts "$OUT/split-web-report.json" > "$OUT/split-web.log" 2>&1 &
WEB_PID=$!

engine_run() {
  LOAD_ENGINE_DB=vyx_load_split LOAD_ENFORCE=1 VYX_RISK_ACTION_TRACE="$ENG_TRACE" \
    VYX_POST_CLOSE_URL="http://127.0.0.1:$PC_PORT/api/internal/post-close" VYX_POST_CLOSE_SECRET=$PC_SECRET VYX_POST_CLOSE_SWEEP_SECS=1 \
    engine/target/debug/parity.exe --load-run "$K" "$1" || echo "[split] engine run exited non-zero"
}

FLIPS="$OUT/flips.json"
if [ "$DRILL" = 1 ]; then
  # the drill: the engine runs; once it has closed DRILL_AFTER positions, ONE statement flips every RUST broker to WEB (the
  # runbook's step "WEB fallback"); the web, polling all along, takes over what is left
  engine_run "$OUT/split-engine-report.json" > "$OUT/split-engine.log" 2>&1 &
  ENG_PID=$!
  FLIPPED=0
  for _ in $(seq 1 600); do
    DONE="$($PG -d $SPLIT -c "select count(*) from \"Transaction\" where type = 'TRADE_PNL' and note like 'Stop%'")"
    if [ "$DONE" -ge "$DRILL_AFTER" ]; then
      ROWS="$($PG -d $SPLIT -F '|' -c "with u as (update \"Broker\" set \"riskAuthority\" = 'WEB' where \"riskAuthority\" = 'RUST' returning id) select id, (extract(epoch from clock_timestamp()) * 1000)::bigint from u")"
      node -e "const rows=process.argv[1].split('\n').filter(Boolean).map(r=>{const [broker,ts]=r.split('|');return {broker,tsMs:Number(ts)}});require('fs').writeFileSync(process.argv[2],JSON.stringify({flips:rows},null,1))" "$ROWS" "$FLIPS"
      echo "[split] FLIPPED $(echo "$ROWS" | wc -l) broker(s) to WEB after $DONE engine stop-out closes"
      FLIPPED=1
      break
    fi
    kill -0 $ENG_PID 2>/dev/null || break
    sleep 0.1
  done
  [ "$FLIPPED" = 1 ] || { echo "[split] the engine finished before $DRILL_AFTER closes: nothing to flip under (use more accounts)"; wait $ENG_PID || true; exit 2; }
  wait $ENG_PID || true
else
  engine_run "$OUT/split-engine-report.json" | tee "$OUT/split-engine.log"
fi

# the web's runner ends after one more pass that closes nothing; then settle: web and engine alternate until neither closes anything
touch "$STOP"
wait $WEB_PID || { cat "$OUT/split-web.log"; echo "[split] the web runner failed"; exit 1; }
for i in 1 2; do
  DATABASE_URL=$SPLIT DIRECT_URL=$SPLIT VYX_RISK_ACTION_TRACE="$WEB_TRACE" LOAD_WEB_STOP_FILE="$STOP" $TSX scripts/load/run-web.ts "$OUT/settle-web-$i.json" >> "$OUT/split-web.log" 2>&1
  engine_run "$OUT/settle-engine-$i.json" >> "$OUT/split-engine.log" 2>&1
done
stop_all
trap - EXIT

DATABASE_URL=$SPLIT DIRECT_URL=$SPLIT $TSX scripts/load/snapshot.ts "$OUT/split-snapshot.json" >/dev/null
RC=0
DATABASE_URL=$SPLIT DIRECT_URL=$SPLIT $TSX scripts/load/exactly-once.ts | tee "$OUT/exactly-once.txt" || RC=1
if grep -q "FAIL" "$OUT/exactly-once.txt"; then RC=1; fi
DATABASE_URL=$SPLIT DIRECT_URL=$SPLIT $TSX scripts/load/split-check.ts "$OUT/world.json" "$VARIANT" "$WEB_TRACE" "$ENG_TRACE" "$OUT/split-snapshot.json" $(if [ "$DRILL" = 1 ]; then echo "$FLIPS"; fi) | tee "$OUT/split-check.txt" || RC=1
if [ "$VARIANT" = "cross-topo" ]; then
  echo "[split] cross-topo: invariants only (a cascade across two concurrent actors is not the web's id order); end state not compared with the web reference"
else
  node scripts/load/diff.mjs "$OUT/world.json" "$OUT/web-snapshot.json" "$OUT/split-snapshot.json" | tee "$OUT/diff.txt" || RC=1
fi
if [ $RC -ne 0 ]; then
  echo "[split] FAILED variant=$VARIANT drill=$DRILL seed=$SEED accounts=$N walkers=$K commit=$(git rev-parse --short HEAD) out=$OUT"
  exit 1
fi
echo "[split] OK variant=$VARIANT drill=$DRILL seed=$SEED accounts=$N walkers=$K"
