-- XAUUSD flat bars of Sunday 2026-10-25 (owner 2026-10-26: plan first, apply only on the owner's go).
--
-- What happened: before the gap_fill Sunday-reopen fix (engine/gap-fill-sunday-reopen 2581f9f), XAUUSD counted as
-- open from the NY-17:00 anchor (21:00 UTC, EDT) instead of 22:00 UTC, so Friday's frozen 3998.07 was written as
-- real M1/M5 bars from 21:35 to 21:48 UTC. Higher timeframes that contain those minutes may carry 3998.07 as their
-- OPEN (first tick of the bucket) and as their HIGH or LOW (GREATEST/LEAST upserts).
--
-- Clock: the engine buckets by the broker server's time (New York close = UTC+3 in summer), so those minutes are
-- most likely stored at "bucketStart" 2026-10-26 00:35-00:48. Step 0 finds them by value, whichever clock it is.
--
-- Where: the VPS engine's own Postgres (table "Candle"), run by the VPS session with psql.
-- When: Step 0 any time (read-only). Steps 1-2 inside the engine deploy, with the market-data engine STOPPED
-- (its in-memory current buckets would otherwise flush the old OPEN/HIGH/LOW back), then start the fixed engine.

-- ---------------------------------------------------------------- Step 0: dry run (read only) -----------------
BEGIN READ ONLY;
-- 0a. the flat M1 bars: open = high = low = close = 3998.07, in a window that covers both clocks
SELECT timeframe, "bucketStart", open, high, low, close, "updatedAt"
FROM "Candle"
WHERE symbol = 'XAUUSD' AND timeframe IN ('M1', 'M5', 'M15', 'M30', 'H1')
  AND "bucketStart" >= '2026-10-25 21:00' AND "bucketStart" < '2026-10-26 02:00'
ORDER BY timeframe, "bucketStart";
-- 0b. the first REAL M1 bar after the reopen (expected 22:00 UTC = 01:00 server): its open is the true week open
SELECT "bucketStart", open FROM "Candle"
WHERE symbol = 'XAUUSD' AND timeframe = 'M1' AND "bucketStart" >= '2026-10-25 21:00' AND "bucketStart" < '2026-10-26 03:00'
  AND NOT (open = 3998.07 AND high = 3998.07 AND low = 3998.07 AND close = 3998.07)
ORDER BY "bucketStart" LIMIT 1;
-- 0c. the higher buckets that contain the flat minutes, as stored now
SELECT timeframe, "bucketStart", open, high, low, close FROM "Candle"
WHERE symbol = 'XAUUSD' AND timeframe IN ('H4', 'D1', 'W1', 'MN1', 'Y1')
  AND "bucketStart" <= '2026-10-26 01:00' AND "bucketStart" > '2025-12-31'
ORDER BY timeframe, "bucketStart" DESC;
-- 0d. other break symbols, same question (only XAUUSD is in scope unless the owner adds them)
SELECT symbol, count(*) FROM "Candle"
WHERE symbol IN ('XAGUSD', 'XPTUSD', 'SpotCrude', 'SpotBrent') AND timeframe = 'M1'
  AND "bucketStart" >= '2026-10-25 21:00' AND "bucketStart" < '2026-10-26 03:00' AND open = high AND high = low AND low = close
GROUP BY symbol;
COMMIT;

-- The owner sees Step 0's output and confirms: (F) the flat window [F_FROM, F_TO) in stored time, from 0a, and
-- (R) the first real bar's bucketStart, from 0b. Steps 1-2 use those values; nothing below runs before that.

-- ---------------------------------------------------------------- Step 1: apply (engine stopped) --------------
-- \set F_FROM '2026-10-26 00:35'   -- from 0a (first flat M1)
-- \set F_TO   '2026-10-26 00:49'   -- from 0a (last flat M1 + 1 minute)
-- \set R      '2026-10-26 01:00'   -- from 0b (first real M1)
BEGIN;
-- 1a. the flat fine bars inside the closed hour: gone (the market was closed, there is no real bar to keep)
DELETE FROM "Candle"
WHERE symbol = 'XAUUSD' AND timeframe IN ('M1', 'M5', 'M15', 'M30', 'H1')
  AND "bucketStart" >= :'F_FROM'::timestamp - interval '59 minutes' AND "bucketStart" < :'R'::timestamp
  AND open = 3998.07 AND high = 3998.07 AND low = 3998.07 AND close = 3998.07;
-- 1b. H4 / D1 / W1 buckets that contain the flat minutes: rebuild open/high/low from the remaining real M1 bars of
--     the same bucket (open = the first real M1's open, high/low = over the real M1s); close is the latest real
--     value already. Only buckets whose start is at or before F_FROM, and whose window holds real M1 bars.
WITH b AS (
  SELECT c.timeframe, c."bucketStart",
         CASE c.timeframe WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '1 day' ELSE interval '7 days' END AS len
  FROM "Candle" c
  WHERE c.symbol = 'XAUUSD' AND c.timeframe IN ('H4', 'D1', 'W1')
    AND c."bucketStart" <= :'F_FROM'::timestamp
    AND c."bucketStart" + CASE c.timeframe WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '1 day' ELSE interval '7 days' END > :'F_FROM'::timestamp
), m AS (
  SELECT b.timeframe, b."bucketStart",
         (array_agg(x.open ORDER BY x."bucketStart"))[1] AS open, max(x.high) AS high, min(x.low) AS low
  FROM b JOIN "Candle" x ON x.symbol = 'XAUUSD' AND x.timeframe = 'M1'
    AND x."bucketStart" >= b."bucketStart" AND x."bucketStart" < b."bucketStart" + b.len
  GROUP BY b.timeframe, b."bucketStart"
)
UPDATE "Candle" c SET open = m.open, high = m.high, low = m.low, "updatedAt" = now()
FROM m
WHERE c.symbol = 'XAUUSD' AND c.timeframe = m.timeframe AND c."bucketStart" = m."bucketStart";
-- (MN1 / Y1 are left alone: 3998.07 is Friday's real close, so it lies inside October's and 2026's real range.
--  Only the new week's buckets, which never traded at that price, are wrong.)
-- check before COMMIT: run Step 2's queries inside this transaction; ROLLBACK if anything looks wrong
-- COMMIT;

-- ---------------------------------------------------------------- Step 2: verify -------------------------------
-- 2a. no flat 3998.07 fine bar left in the window (expect 0 rows)
-- 2b. H4 / D1 / W1 open = 0b's first real open; high/low = max/min of their real M1s
-- 2c. after the fixed engine starts: the XAUUSD 1H / M1 chart around Sunday 22:00 UTC shows no 3998.07 flat line
