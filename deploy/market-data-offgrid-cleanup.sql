-- Off-grid ("phantom") candle cleanup -- fix/deep-backfill-full-history.
--
-- Hand-runnable twin of engine/market-data/src/retention.rs's
-- sweep_offgrid_candles (which the engine now runs at every boot and
-- nightly). Use this when you want to see the numbers before/after, or on
-- a store the new engine build is not running against yet:
--
--     psql -U engine -h 127.0.0.1 -d market_data -f market-data-offgrid-cleanup.sql
--
-- What it removes: every "Candle" row whose "bucketStart" is not on its
-- timeframe's grid. Before EA v1.39 the EA's UTC conversion
-- (TimeTradeServer() - TimeGMT(), two second-resolution reads) could come
-- out as 10799/10801 instead of 10800, and every bar of every history pass
-- in that window landed at hh:mm:01 (or hh:mm:59) -- a brand-new row one
-- second beside the real bucket. Nothing the engine writes itself is ever
-- off-grid (bucket_start floors; gap fills step from a floored start), so
-- an unaligned row can only be one of those phantoms.
--
-- Grid per timeframe (= market_data::bucket_is_aligned): M1..H1 a whole
-- multiple of their own span from the epoch; H4/D1 (shifted by the broker
-- offset, whole hours or :30) and W1/MN1/Y1 (calendar buckets) a whole
-- minute. Epoch MILLISECONDS, so a sub-second bucketStart is caught too
-- (the column is TIMESTAMPTZ(3)).
--
-- Idempotent. The DELETE is wrapped in a transaction and prints the rows
-- it removed per timeframe; the two preview SELECTs run first so the
-- runbook can record the before-count, and the same SELECT after commit
-- must read 0 everywhere.

\set ON_ERROR_STOP on
SET TIME ZONE 'UTC';   -- bucketStart is UTC everywhere in this system; print it that way

-- 1. Preview: how many phantoms, per timeframe (expect 0 after the sweep).
SELECT timeframe,
       count(*)           AS off_grid_rows,
       min("bucketStart") AS oldest,
       max("bucketStart") AS newest
FROM "Candle"
WHERE (EXTRACT(EPOCH FROM "bucketStart") * 1000)::bigint
      % (CASE timeframe
           WHEN 'M1'  THEN    60000
           WHEN 'M5'  THEN   300000
           WHEN 'M15' THEN   900000
           WHEN 'M30' THEN  1800000
           WHEN 'H1'  THEN  3600000
           ELSE               60000   -- H4, D1, W1, MN1, Y1: whole-minute rule only
         END) <> 0
GROUP BY timeframe
ORDER BY timeframe;

-- 2. Preview: the seconds-offset shape of the phantoms (all :01 / :59 = the
--    EA straddle; anything else is worth a look before deleting).
SELECT timeframe,
       EXTRACT(SECOND FROM "bucketStart")::int AS second_of_minute,
       count(*)                                AS rows
FROM "Candle"
WHERE (EXTRACT(EPOCH FROM "bucketStart") * 1000)::bigint % 60000 <> 0
GROUP BY 1, 2
ORDER BY 1, 2;

-- 3. Delete, in one transaction, reporting the per-timeframe count.
BEGIN;

WITH gone AS (
    DELETE FROM "Candle"
    WHERE (EXTRACT(EPOCH FROM "bucketStart") * 1000)::bigint
          % (CASE timeframe
               WHEN 'M1'  THEN    60000
               WHEN 'M5'  THEN   300000
               WHEN 'M15' THEN   900000
               WHEN 'M30' THEN  1800000
               WHEN 'H1'  THEN  3600000
               ELSE               60000
             END) <> 0
    RETURNING timeframe
)
SELECT timeframe, count(*) AS deleted
FROM gone
GROUP BY timeframe
ORDER BY timeframe;

COMMIT;

-- 4. Verify: must return no rows.
SELECT timeframe, count(*) AS off_grid_rows_remaining
FROM "Candle"
WHERE (EXTRACT(EPOCH FROM "bucketStart") * 1000)::bigint
      % (CASE timeframe
           WHEN 'M1'  THEN    60000
           WHEN 'M5'  THEN   300000
           WHEN 'M15' THEN   900000
           WHEN 'M30' THEN  1800000
           WHEN 'H1'  THEN  3600000
           ELSE               60000
         END) <> 0
GROUP BY timeframe;
