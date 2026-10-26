-- W1 onto MT5's grid (owner 2026-10-26). Part of ONE combined run with engine/scripts/cleanup-2026-10-25-sunday-flat-bars.sql:
-- system32-ed puts this AFTER the flat-bar cleanup, in the same Step 1 transaction, with the market-data engine STOPPED, and only
-- once the engine build with fix/w1-sunday-mn1-y1-offset (W1 starts Sunday 00:00 server) is the one that starts afterwards; the old
-- engine would write the Monday rows again.
--
-- Two W1 series per symbol until now:
--   * MT5 / EA grid: Sunday 00:00 server = Saturday 21:00 UTC (summer, +3) / 22:00 UTC (winter, +2): isodow 6. KEPT.
--   * engine grid:   Monday 00:00 server = Sunday 21:00 / 22:00 UTC: isodow 7. Each row belongs to the week that started 24 h
--     earlier (Sunday's server day has no trading, so both rows describe the same ticks).
-- Per engine-grid row: target = bucketStart - 24 h (fixed hours, UTC session: no DST arithmetic).
--   * no target row          -> the engine row MOVES to the target (it was the only bar of that week);
--   * target with equal OHLC -> the engine row is deleted;
--   * target with other OHLC -> the target is rebuilt from its week's real M1 bars [target, target + 168 h) when any exist, else the
--                               target (the EA's MT5 bar) is kept as is; then the engine row is deleted.
-- Never touched: any W1 row on neither grid (counted in Step 0; if any exists Step 1 aborts, nothing changed); every other timeframe.
-- MN1 / Y1 / D1 / H4 second rows from the season offset (an hour apart) are only PREVIEWED in Step 0, not changed.

-- ================================================================ Step 0: dry run (read only) ===========================
BEGIN READ ONLY;
SET LOCAL TIME ZONE 'UTC';
-- 0a. W1 rows by grid
SELECT CASE WHEN extract(isodow FROM "bucketStart") = 6 AND extract(hour FROM "bucketStart") IN (21, 22) AND extract(minute FROM "bucketStart") = 0 THEN 'mt5 (keep)'
            WHEN extract(isodow FROM "bucketStart") = 7 AND extract(hour FROM "bucketStart") IN (21, 22) AND extract(minute FROM "bucketStart") = 0 THEN 'engine (merge)'
            ELSE 'NEITHER (Step 1 aborts)' END AS grid,
       count(*) AS rows, count(DISTINCT symbol) AS symbols, min("bucketStart") AS first, max("bucketStart") AS last
  FROM "Candle" WHERE timeframe = 'W1' GROUP BY 1 ORDER BY 1;
-- 0b. what Step 1 would do with each engine-grid row
WITH e AS (
  SELECT symbol, "bucketStart" AS e_start, "bucketStart" - interval '24 hours' AS target, open, high, low, close
    FROM "Candle" WHERE timeframe = 'W1' AND extract(isodow FROM "bucketStart") = 7 AND extract(hour FROM "bucketStart") IN (21, 22)
)
SELECT CASE WHEN t.symbol IS NULL THEN 'move' WHEN (t.open, t.high, t.low, t.close) = (e.open, e.high, e.low, e.close) THEN 'delete (equal)'
            WHEN m.n > 0 THEN 'rebuild target from M1, delete' ELSE 'keep MT5 target, delete' END AS action,
       count(*) AS rows, min(e.target) AS first_week, max(e.target) AS last_week
  FROM e
  LEFT JOIN "Candle" t ON t.symbol = e.symbol AND t.timeframe = 'W1' AND t."bucketStart" = e.target
  LEFT JOIN LATERAL (SELECT count(*) AS n FROM "Candle" x WHERE x.symbol = e.symbol AND x.timeframe = 'M1'
                       AND x."bucketStart" >= e.target AND x."bucketStart" < e.target + interval '168 hours') m ON true
 GROUP BY 1 ORDER BY 1;
-- 0c. preview only: MN1 / Y1 / D1 / H4 rows exactly one hour from another row of the same symbol (the season-offset duplicates)
SELECT a.timeframe, count(*) AS pairs, min(a."bucketStart") AS first, max(a."bucketStart") AS last
  FROM "Candle" a JOIN "Candle" b ON b.symbol = a.symbol AND b.timeframe = a.timeframe AND b."bucketStart" = a."bucketStart" + interval '1 hour'
 WHERE a.timeframe IN ('MN1', 'Y1', 'D1', 'H4')
 GROUP BY 1 ORDER BY 1;
COMMIT;

-- ================================================================ Step 1: apply (engine stopped, owner's OK) ===========
-- system32-ed: in the combined file this block goes inside the same transaction, after the flat-bar cleanup's last statement and
-- before its COMMIT; the SET LOCAL and the guard below come with it.
BEGIN;
SET LOCAL TIME ZONE 'UTC';
DO $$
DECLARE odd integer;
BEGIN
  SELECT count(*) INTO odd FROM "Candle" WHERE timeframe = 'W1'
     AND NOT (extract(isodow FROM "bucketStart") IN (6, 7) AND extract(hour FROM "bucketStart") IN (21, 22) AND extract(minute FROM "bucketStart") = 0);
  IF odd > 0 THEN RAISE EXCEPTION 'w1 grid refused: % W1 row(s) on neither grid; nothing changed', odd; END IF;
END $$;

CREATE TEMP TABLE w1_e ON COMMIT DROP AS
SELECT e.symbol, e."bucketStart" AS e_start, e."bucketStart" - interval '24 hours' AS target, e.open, e.high, e.low, e.close,
       (t.symbol IS NOT NULL) AS has_target,
       (t.symbol IS NOT NULL AND (t.open, t.high, t.low, t.close) = (e.open, e.high, e.low, e.close)) AS equal
  FROM "Candle" e
  LEFT JOIN "Candle" t ON t.symbol = e.symbol AND t.timeframe = 'W1' AND t."bucketStart" = e."bucketStart" - interval '24 hours'
 WHERE e.timeframe = 'W1' AND extract(isodow FROM e."bucketStart") = 7 AND extract(hour FROM e."bucketStart") IN (21, 22);

-- targets that differ: rebuilt from their week's real M1 bars when any exist (else the MT5 bar stays as it is)
WITH r AS (
  SELECT w.symbol, w.target,
         (array_agg(x.open ORDER BY x."bucketStart"))[1] AS open, max(x.high) AS high, min(x.low) AS low,
         (array_agg(x.close ORDER BY x."bucketStart" DESC))[1] AS close
    FROM w1_e w JOIN "Candle" x ON x.symbol = w.symbol AND x.timeframe = 'M1'
     AND x."bucketStart" >= w.target AND x."bucketStart" < w.target + interval '168 hours'
   WHERE w.has_target AND NOT w.equal
   GROUP BY w.symbol, w.target
)
UPDATE "Candle" c SET open = r.open, high = r.high, low = r.low, close = r.close, "updatedAt" = now()
  FROM r WHERE c.symbol = r.symbol AND c.timeframe = 'W1' AND c."bucketStart" = r.target;

-- engine rows with no MT5 row: moved onto the MT5 grid
UPDATE "Candle" c SET "bucketStart" = w.target, "updatedAt" = now()
  FROM w1_e w WHERE NOT w.has_target AND c.symbol = w.symbol AND c.timeframe = 'W1' AND c."bucketStart" = w.e_start;

-- the remaining engine rows (their week has its MT5 row now): deleted
DELETE FROM "Candle" c USING w1_e w WHERE w.has_target AND c.symbol = w.symbol AND c.timeframe = 'W1' AND c."bucketStart" = w.e_start;

-- 1z. check before COMMIT: no engine-grid W1 row left (expect 0), and the counts per action
SELECT count(*) AS engine_grid_left FROM "Candle"
 WHERE timeframe = 'W1' AND extract(isodow FROM "bucketStart") = 7 AND extract(hour FROM "bucketStart") IN (21, 22);
SELECT CASE WHEN NOT has_target THEN 'moved' WHEN equal THEN 'deleted (equal)' ELSE 'target rebuilt or kept, deleted' END AS action, count(*)
  FROM w1_e GROUP BY 1 ORDER BY 1;
-- COMMIT;   (or ROLLBACK if anything above looks wrong)
