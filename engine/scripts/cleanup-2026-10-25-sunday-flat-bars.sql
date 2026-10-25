-- Sunday 2026-10-25 flat bars of the 5 break symbols (owner 2026-10-26: plan, then apply only on the owner's go).
--
-- What happened: before the gap_fill Sunday-reopen fix (engine/gap-fill-sunday-reopen 2581f9f), a break symbol
-- counted as open from the NY-17:00 anchor (Sun 21:00 UTC, EDT) instead of anchor + its break (metals / SpotCrude
-- 22:00 UTC, SpotBrent 00:00 UTC). Friday's frozen price was written as real bars in that hour (XAUUSD 3998.07,
-- 21:35-21:48 UTC). Higher buckets that contain those minutes may carry it as their OPEN / HIGH / LOW.
--
-- Owner rules: (1) a bar is removed only by VALUE: open = high = low = close = that symbol's own last close before the
-- weekend, and only inside its closed window; (2) the 5 symbols XAUUSD XAGUSD XPTUSD SpotCrude SpotBrent; (3) if any
-- bar inside a closed window is NOT flat (open <> close, or high <> low) or flat at another price, the whole
-- transaction aborts (ROLLBACK): nothing is changed.
--
-- Literals are pinned to +00: "bucketStart" is timestamptz and the engine stores the server's wall clock as UTC, so
-- the psql session's own time zone must not shift them.
-- Clock: the engine buckets by the broker server's time (New York close = UTC+3 in summer), so the closed windows
-- below are in SERVER time: Mon 2026-10-26 00:00 -> 01:00 (03:00 for SpotBrent) = Sun 21:00 -> 22:00 (00:00) UTC.
-- Step 0 shows both clocks; if the flat bars sit at 21:xx instead, the data is in UTC: subtract 3 hours from every
-- window below (all three places say WINDOWS) and run Step 0 again.
--
-- Where: the VPS engine's own Postgres (table "Candle"), run by the VPS session with psql -v ON_ERROR_STOP=1.
-- When: Step 0 any time (read only). Backup + Step 1 inside the engine deploy with the market-data engine STOPPED
-- (its in-memory current buckets would flush the old OPEN/HIGH/LOW back), then start the fixed engine.
--
-- Tested 2026-10-26 on a synthetic copy of "Candle" (scratch Postgres, session time zone Asia/Karachi): flat bars
-- removed, Friday and real bars kept, H4 / D1 / W1 rebuilt, XAGUSD and BTCUSD untouched; a non-flat bar and a flat
-- bar at another price inside a window each abort Step 1 with the table byte-identical.

-- ============================================================ Step 0: dry run (read only) ======================
BEGIN READ ONLY;
-- WINDOWS
WITH w(symbol, w_from, w_to) AS (VALUES
  ('XAUUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('XAGUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('XPTUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('SpotCrude', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('SpotBrent', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 03:00+00')
), fri AS (
  SELECT w.*, (SELECT c.close FROM "Candle" c WHERE c.symbol = w.symbol AND c.timeframe = 'M1' AND c."bucketStart" < w.w_from
               ORDER BY c."bucketStart" DESC LIMIT 1) AS fri_close
  FROM w
)
SELECT f.symbol, f.fri_close, c.timeframe,
       count(*) FILTER (WHERE c.open = c.high AND c.high = c.low AND c.low = c.close AND c.close = f.fri_close) AS flat_at_friday_close,
       count(*) FILTER (WHERE NOT (c.open = c.high AND c.high = c.low AND c.low = c.close AND c.close = f.fri_close)) AS other_bars_MUST_BE_0,
       min(c."bucketStart") AS first_bar, max(c."bucketStart") AS last_bar
FROM fri f JOIN "Candle" c ON c.symbol = f.symbol AND c.timeframe IN ('M1', 'M5', 'M15', 'M30', 'H1')
  AND c."bucketStart" >= f.w_from AND c."bucketStart" < f.w_to
GROUP BY f.symbol, f.fri_close, c.timeframe ORDER BY f.symbol, c.timeframe;
-- the same 5 symbols, one clock earlier (UTC reading): non-zero here means the data is in UTC, see "Clock" above
SELECT symbol, count(*) AS m1_bars_sun_21_to_22_utc FROM "Candle"
WHERE symbol IN ('XAUUSD', 'XAGUSD', 'XPTUSD', 'SpotCrude', 'SpotBrent') AND timeframe = 'M1'
  AND "bucketStart" >= '2026-10-25 21:00+00' AND "bucketStart" < '2026-10-26 00:00+00'
GROUP BY symbol ORDER BY symbol;
-- WINDOWS
-- the H4 / D1 / W1 buckets that contain a window, now vs rebuilt from their real M1 bars (what Step 1 will write)
WITH w(symbol, w_from, w_to) AS (VALUES
  ('XAUUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('XAGUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('XPTUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('SpotCrude', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('SpotBrent', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 03:00+00')
), b AS (
  SELECT w.symbol, w.w_from, w.w_to, c.timeframe, c."bucketStart", c.open, c.high, c.low, c.close,
         CASE c.timeframe::text WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '1 day' ELSE interval '7 days' END AS len
  FROM w JOIN "Candle" c ON c.symbol = w.symbol AND c.timeframe IN ('H4', 'D1', 'W1') AND c."bucketStart" <= w.w_from
  WHERE c."bucketStart" + CASE c.timeframe::text WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '1 day' ELSE interval '7 days' END > w.w_from
)
SELECT b.symbol, b.timeframe, b."bucketStart", b.open AS open_now, b.high AS high_now, b.low AS low_now,
       (array_agg(x.open ORDER BY x."bucketStart"))[1] AS open_rebuilt, max(x.high) AS high_rebuilt, min(x.low) AS low_rebuilt,
       count(x.*) AS real_m1_bars
FROM b LEFT JOIN "Candle" x ON x.symbol = b.symbol AND x.timeframe = 'M1' AND x."bucketStart" >= b."bucketStart"
  AND x."bucketStart" < b."bucketStart" + b.len AND NOT (x."bucketStart" >= b.w_from AND x."bucketStart" < b.w_to)
GROUP BY b.symbol, b.timeframe, b."bucketStart", b.open, b.high, b.low ORDER BY b.symbol, b.timeframe;
COMMIT;

-- The owner sees Step 0 and says go. Then, engine stopped, back up the rows this can touch:
--   \copy (SELECT * FROM "Candle" WHERE symbol IN ('XAUUSD','XAGUSD','XPTUSD','SpotCrude','SpotBrent')
--          AND "bucketStart" >= '2026-10-19+00' AND "bucketStart" < '2026-10-27+00') TO 'C:\vyxtrader\backup\candle-2026-10-25-sunday.csv' CSV HEADER

-- ============================================================ Step 1: apply (engine stopped) ==================
BEGIN;
-- WINDOWS
CREATE TEMP TABLE cleanup_w ON COMMIT DROP AS
SELECT w.*, (SELECT c.close FROM "Candle" c WHERE c.symbol = w.symbol AND c.timeframe = 'M1' AND c."bucketStart" < w.w_from
             ORDER BY c."bucketStart" DESC LIMIT 1) AS fri_close
FROM (VALUES
  ('XAUUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('XAGUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('XPTUSD', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('SpotCrude', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 01:00+00'),
  ('SpotBrent', timestamptz '2026-10-26 00:00+00', timestamptz '2026-10-26 03:00+00')
) AS w(symbol, w_from, w_to);

-- 1a. the guard (owner rule 3): any bar inside a closed window that is not flat at the Friday close aborts everything
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad
  FROM cleanup_w w JOIN "Candle" c ON c.symbol = w.symbol AND c.timeframe IN ('M1', 'M5', 'M15', 'M30', 'H1')
    AND c."bucketStart" >= w.w_from AND c."bucketStart" < w.w_to
  WHERE w.fri_close IS NULL OR NOT (c.open = c.high AND c.high = c.low AND c.low = c.close AND c.close = w.fri_close);
  IF bad > 0 THEN
    RAISE EXCEPTION 'cleanup refused: % bar(s) inside a closed window are not flat at the Friday close (open <> close or another price); nothing changed', bad;
  END IF;
END $$;

-- 1b. the flat bars inside the closed windows: removed (the market was closed, there is no real bar to keep)
DELETE FROM "Candle" c USING cleanup_w w
WHERE c.symbol = w.symbol AND c.timeframe IN ('M1', 'M5', 'M15', 'M30', 'H1')
  AND c."bucketStart" >= w.w_from AND c."bucketStart" < w.w_to
  AND c.open = w.fri_close AND c.high = w.fri_close AND c.low = w.fri_close AND c.close = w.fri_close;

-- 1c. H4 / D1 / W1 buckets that contain a window: open / high / low rebuilt from the bucket's remaining real M1 bars
--     (close is the latest real value already). A bucket with no real M1 left is deleted (it only held the flat bars).
--     MN1 / Y1 stay: each symbol's Friday close is a real price inside its month's and year's range.
CREATE TEMP TABLE cleanup_b ON COMMIT DROP AS
SELECT c.symbol, c.timeframe, c."bucketStart",
       (array_agg(x.open ORDER BY x."bucketStart"))[1] AS open, max(x.high) AS high, min(x.low) AS low, count(x.*) AS n
FROM cleanup_w w
JOIN "Candle" c ON c.symbol = w.symbol AND c.timeframe IN ('H4', 'D1', 'W1') AND c."bucketStart" <= w.w_from
  AND c."bucketStart" + CASE c.timeframe::text WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '1 day' ELSE interval '7 days' END > w.w_from
LEFT JOIN "Candle" x ON x.symbol = c.symbol AND x.timeframe = 'M1' AND x."bucketStart" >= c."bucketStart"
  AND x."bucketStart" < c."bucketStart" + CASE c.timeframe::text WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '1 day' ELSE interval '7 days' END
GROUP BY c.symbol, c.timeframe, c."bucketStart";
UPDATE "Candle" c SET open = b.open, high = b.high, low = b.low, "updatedAt" = now()
FROM cleanup_b b WHERE b.n > 0 AND c.symbol = b.symbol AND c.timeframe = b.timeframe AND c."bucketStart" = b."bucketStart";
DELETE FROM "Candle" c USING cleanup_b b
WHERE b.n = 0 AND c.symbol = b.symbol AND c.timeframe = b.timeframe AND c."bucketStart" = b."bucketStart";

-- 1d. what changed, for the record (check it, then COMMIT; anything unexpected: ROLLBACK)
SELECT symbol, timeframe, "bucketStart", open, high, low, close FROM "Candle" c
WHERE (symbol, timeframe::text, "bucketStart") IN (SELECT symbol, timeframe::text, "bucketStart" FROM cleanup_b)
ORDER BY symbol, timeframe;
-- COMMIT;

-- ============================================================ Step 2: verify ==================================
-- 2a. Step 0's first query again: no rows (nothing left inside the closed windows)
-- 2b. H4 / D1 / W1: open = the first real M1 at or after the window's end, high / low = over the real M1s
-- 2c. after the fixed engine starts: each symbol's chart around Sunday 22:00 UTC shows no flat line at Friday's close
