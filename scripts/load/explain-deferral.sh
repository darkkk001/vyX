#!/usr/bin/env bash
# Stage 4 §4.8 -- cost of the engine's deferral query (order_management::book::pending_follow_up_state) and of the
# per-pass precheck, on the scratch load database vyx_load_engine ONLY. Run after scripts/load/run.sh has left a
# settled world in it.
#
#   bash scripts/load/explain-deferral.sh
#
# Steps: the real rows; +5 PENDING; +1k DONE; +100k DONE (history piling up). Each: the plan (EXPLAIN ANALYZE,
# BUFFERS) for one account holding a mirror target, and the mean time over 2000 executions across real account ids.
# The extra rows are removed at the end.
set -euo pipefail
PSQL="/d/pg-scratch/pgsql/bin/psql.exe -h 127.0.0.1 -p 5499 -U postgres -d vyx_load_engine -X -q"
[ "$($PSQL -Atc "select current_database()")" = "vyx_load_engine" ] || { echo "refusing: not vyx_load_engine"; exit 2; }

# the query exactly as book.rs sends it ($1 account, $2 window seconds), as a plain SQL string for EXECUTE ... USING
read -r -d '' Q_STATE <<'SQL' || true
WITH owed AS (
  SELECT e."createdAt" FROM "PostCloseEffect" e
  JOIN "MirrorLink" ml ON ml."sourcePositionId" = e."positionId"
  JOIN "Position" t ON t.id = ml."targetPositionId"
  WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('mirror' = ANY(e."doneSteps"))
    AND t."accountId" = $1 AND t.status = 'OPEN'
  UNION ALL
  SELECT e."createdAt" FROM "PostCloseEffect" e
  JOIN "Position" s ON s.id = e."positionId"
  JOIN "Position" leg ON leg.id = s."coveragePositionId"
  WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('coverage' = ANY(e."doneSteps"))
    AND leg."accountId" = $1 AND leg.status = 'OPEN' AND leg."autoHedged"
  UNION ALL
  SELECT e."createdAt" FROM "PostCloseEffect" e
  JOIN "Position" client ON client."coveragePositionId" = e."positionId"
  WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('coverage' = ANY(e."doneSteps"))
    AND client."accountId" = $1 AND client.status = 'OPEN'
)
SELECT count(*) > 0, coalesce(bool_or("createdAt" > now() - ($2::int * interval '1 second')), false) FROM owed
SQL
Q_PRECHECK='SELECT EXISTS (SELECT 1 FROM "PostCloseEffect" WHERE status = '"'"'PENDING'"'"' AND kind = '"'"'POSITION_CLOSED'"'"')'
# dollar-quoted copies for use inside the DO block
DQ_STATE="\$q\$${Q_STATE}\$q\$"
DQ_PRECHECK="\$q\$${Q_PRECHECK}\$q\$"

measure() {
  local label=$1
  echo "=== $label"
  $PSQL -Atc "SELECT status || ' ' || count(*) FROM \"PostCloseEffect\" GROUP BY status ORDER BY 1"
  local acct
  acct=$($PSQL -Atc "SELECT t.\"accountId\" FROM \"MirrorLink\" ml JOIN \"Position\" t ON t.id = ml.\"targetPositionId\" LIMIT 1")
  echo "--- plan for $acct"
  $PSQL <<SQL | grep -E "Execution Time|Planning Time|Buffers|Scan|Join|Nested|Hash" | sed 's/^/    /' | head -25
PREPARE st(text, int) AS ${Q_STATE};
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) EXECUTE st('${acct}', 30);
SQL
  $PSQL <<SQL 2>&1 | grep -E "mean" | sed 's/^.*NOTICE: *//'
DO \$\$
DECLARE ids text[]; t0 timestamptz; a boolean; b boolean; i int;
BEGIN
  SELECT array_agg(DISTINCT "accountId") INTO ids FROM "Position";
  t0 := clock_timestamp();
  FOR i IN 1..2000 LOOP EXECUTE ${DQ_STATE} INTO a, b USING ids[1 + (i % array_length(ids, 1))], 30; END LOOP;
  RAISE NOTICE 'per-account deferral query mean % ms (% accounts)', round((extract(epoch FROM clock_timestamp() - t0) * 1000 / 2000)::numeric, 4), array_length(ids, 1);
  t0 := clock_timestamp();
  FOR i IN 1..2000 LOOP EXECUTE ${DQ_PRECHECK} INTO a; END LOOP;
  RAISE NOTICE 'per-pass precheck        mean % ms', round((extract(epoch FROM clock_timestamp() - t0) * 1000 / 2000)::numeric, 4);
END \$\$;
SQL
}

add_rows() {
  local n=$1 status=$2 batch=$3
  $PSQL -c "INSERT INTO \"PostCloseEffect\" (id, kind, \"dedupeKey\", \"brokerId\", \"accountId\", \"positionId\", reason, payload, status)
            SELECT 'explain-$batch-' || g, 'POSITION_CLOSED', 'explain-$batch-' || g, b.id, 'x', p.id, 'stop_out', '{}'::jsonb, '$status'
            FROM generate_series(1, $n) g
            CROSS JOIN LATERAL (SELECT id FROM \"Broker\" LIMIT 1) b
            CROSS JOIN LATERAL (SELECT id FROM \"Position\" WHERE status = 'CLOSED' ORDER BY id OFFSET (g % 50) LIMIT 1) p"
  $PSQL -c "ANALYZE \"PostCloseEffect\""
}

$PSQL -c "DELETE FROM \"PostCloseEffect\" WHERE id LIKE 'explain-%'"
measure "settled world (real rows only)"
add_rows 5 PENDING p
measure "+5 PENDING"
add_rows 1000 DONE d1
measure "+1k DONE"
add_rows 100000 DONE d2
measure "+100k DONE"
$PSQL -c "DELETE FROM \"PostCloseEffect\" WHERE id LIKE 'explain-%'" -c "ANALYZE \"PostCloseEffect\""
