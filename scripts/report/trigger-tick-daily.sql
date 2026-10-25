-- Daily touch-to-write / slippage report from the engine's POSITION_CLOSED trigger tick (docs/RUST-CUTOVER-PLAN.md 6.1).
-- Read only. Run with: psql -X -v since="'2026-10-26 21:00'" -f scripts/report/trigger-tick-daily.sql -d <url>
-- engineDelayMs = closeEngineAt - triggerTickEngineAt (one clock, the engine's). Adverse slippage > 0 = filled worse than the level.
-- Writes nothing: the only object is a TEMP view inside a transaction that is rolled back at the end.
BEGIN;

CREATE TEMP VIEW tt AS
SELECT e."createdAt", e.reason, a."accountMode"::text AS mode, s.name AS symbol, p.side::text AS side,
       e.payload->>'triggerSource' AS src, e.payload->>'triggerPriceSource' AS price_src,
       (e.payload->>'engineDelayMs')::int AS delay_ms,
       (e.payload->>'closePrice')::numeric AS fill, p."slPrice" AS sl, p."tpPrice" AS tp,
       CASE e.reason
         WHEN 'stop_loss'   THEN CASE p.side::text WHEN 'BUY' THEN p."slPrice" - (e.payload->>'closePrice')::numeric ELSE (e.payload->>'closePrice')::numeric - p."slPrice" END
         WHEN 'take_profit' THEN CASE p.side::text WHEN 'BUY' THEN p."tpPrice" - (e.payload->>'closePrice')::numeric ELSE (e.payload->>'closePrice')::numeric - p."tpPrice" END
       END AS adverse,
       extract(epoch FROM (e.payload->>'triggerTickEngineAt')::timestamptz - (e.payload->>'triggerTickAt')::timestamptz) * 1000 AS feed_to_engine_ms
  FROM "PostCloseEffect" e
  JOIN "Position" p ON p.id = e."positionId"
  JOIN "Account" a ON a.id = e."accountId"
  JOIN "Symbol" s ON s.id = p."symbolId"
 WHERE e.kind = 'POSITION_CLOSED' AND e."createdAt" >= (:since)::timestamptz AT TIME ZONE 'UTC';

-- 1. coverage: every engine close since the deploy must carry the trigger tick
SELECT mode, count(*) AS closes, count(delay_ms) AS with_trigger_tick, count(*) - count(delay_ms) AS missing FROM tt GROUP BY mode ORDER BY mode;

-- 2. delay on the engine clock, by reason and source (fire = the per-tick trigger, pass = the backstop / pass)
SELECT mode, reason, src, count(*) AS n,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY delay_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY delay_ms) AS p95_ms,
       max(delay_ms) AS max_ms
  FROM tt WHERE delay_ms IS NOT NULL GROUP BY mode, reason, src ORDER BY mode, reason, src;

-- 3. SL / TP slippage past the level, per symbol (stop-outs have no level)
SELECT mode, symbol, reason, count(*) AS n,
       count(*) FILTER (WHERE adverse > 0) AS worse_than_level,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY adverse) AS p50_adverse,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY adverse) AS p95_adverse,
       max(adverse) AS max_adverse
  FROM tt WHERE reason IN ('stop_loss', 'take_profit') GROUP BY mode, symbol, reason ORDER BY mode, symbol, reason;

-- 4. feed clock vs engine clock (information: the skew the engine-clock delay leaves out)
SELECT symbol, count(*) AS n,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY feed_to_engine_ms) AS p50_ms,
       min(feed_to_engine_ms) AS min_ms, max(feed_to_engine_ms) AS max_ms
  FROM tt WHERE feed_to_engine_ms IS NOT NULL GROUP BY symbol ORDER BY symbol;

-- 5. the worst 10 closes by delay, to read by hand
SELECT "createdAt", mode, symbol, reason, src, price_src, delay_ms, fill, sl, tp, adverse FROM tt ORDER BY delay_ms DESC NULLS FIRST LIMIT 10;

ROLLBACK;
