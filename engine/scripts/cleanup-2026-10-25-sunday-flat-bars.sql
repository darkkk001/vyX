-- Sunday 2026-10-25 flat bars of the 5 break symbols (owner 2026-10-26: plan, then apply only on the owner's go).
--
-- What happened: before the gap_fill Sunday-reopen fix (in flip build 0371664), a break symbol counted as open from the
-- NY-17:00 anchor (Sun 21:00 UTC, EDT) instead of anchor + its break, so Friday's frozen price was written as real
-- bars after 21:00 UTC (XAUUSD 3998.07). Higher buckets containing those minutes may carry it as OPEN / HIGH / LOW.
--
-- Owner rules (2026-10-26, from the VPS dry run of the first version):
--   1. The data is in UTC: the closed hours below are UTC (Sun 21:00-22:00; SpotBrent 21:00-00:00).
--   2. Each symbol's window is its ACTUAL contiguous flat run: from the first M1 in the closed hours that is flat at
--      that symbol's own Friday close (open = high = low = close = the last M1 close before 21:00), to the first M1
--      after it that is not. Real bars are never inside a run (SpotBrent's real trading inside its hours stays).
--   3. Only buckets that overlap a run are touched: rebuilt from their remaining real M1 bars. A bucket with no real
--      M1 left is skipped, except an M5 / M15 / M30 / H1 bar that is itself flat at the Friday close (removed, like the
--      M1s). H4 / D1 / W1 are never deleted. MN1 / Y1 stay (the Friday close is a real price inside their range).
--   4. Abort (ROLLBACK, nothing changed) if a run runs more than 10 minutes past its closed hours, or its Friday
--      close is unknown.
-- Literals are pinned to +00 and each transaction runs SET LOCAL TIME ZONE 'UTC'; bucket lengths are fixed hours (24 / 168),
-- never '1 day' / '7 days', which follow the session's DST (owner, VPS v2 Step 0: last week's W1 was caught that way).
--
-- Where: the VPS engine's own Postgres (table "Candle"), psql -v ON_ERROR_STOP=1, by the VPS session.
-- When: Step 0 any time (read only). Backup + Step 1 inside the engine deploy with the market-data engine STOPPED
-- (its in-memory current buckets would flush the old OPEN/HIGH/LOW back), then start the fixed engine.
-- Tested 2026-10-26 on a synthetic "Candle" built from the VPS dry-run findings (session time zone Asia/Karachi).

-- ============================================================ Step 0: dry run (read only) ======================
BEGIN READ ONLY;
-- whatever the psql session's time zone: all interval arithmetic in UTC (a '7 days' step across a DST change
-- would move 21:00 UTC to 22:00); every bucket length is also in fixed hours
SET LOCAL TIME ZONE 'UTC';
-- 0a. each symbol's flat run (a symbol without one is not listed)
-- RUNS: each symbol's flat run, derived from the data (one definition, used by Step 0 and Step 1).
-- outer = the closed hours in UTC (only used to find where a run STARTS); fri_close = the last M1 close before them;
-- run_from = the first M1 in the closed hours that is flat at fri_close; run_end = the first M1 after it that is NOT
-- (the reopen); run_to = the last flat M1 before run_end + 1 minute.
WITH outer_w(symbol, o_from, o_to) AS (VALUES
  ('XAUUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('XAGUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('XPTUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('SpotCrude', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('SpotBrent', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-26 00:00+00')
), fri AS (
  SELECT o.*, (SELECT c.close FROM "Candle" c WHERE c.symbol = o.symbol AND c.timeframe = 'M1' AND c."bucketStart" < o.o_from
               ORDER BY c."bucketStart" DESC LIMIT 1) AS fri_close
  FROM outer_w o
), starts AS (
  SELECT f.*, (SELECT min(c."bucketStart") FROM "Candle" c WHERE c.symbol = f.symbol AND c.timeframe = 'M1'
                 AND c."bucketStart" >= f.o_from AND c."bucketStart" < f.o_to
                 AND c.open = f.fri_close AND c.high = f.fri_close AND c.low = f.fri_close AND c.close = f.fri_close) AS run_from
  FROM fri f
), ends AS (
  SELECT s.*, (SELECT min(c."bucketStart") FROM "Candle" c WHERE c.symbol = s.symbol AND c.timeframe = 'M1'
                 AND c."bucketStart" > s.run_from
                 AND NOT (c.open = s.fri_close AND c.high = s.fri_close AND c.low = s.fri_close AND c.close = s.fri_close)) AS run_end
  FROM starts s
), runs AS (
  SELECT e.symbol, e.o_from, e.o_to, e.fri_close, e.run_from, e.run_end,
         (SELECT max(c."bucketStart") FROM "Candle" c WHERE c.symbol = e.symbol AND c.timeframe = 'M1'
            AND c."bucketStart" >= e.run_from AND c."bucketStart" < coalesce(e.run_end, 'infinity')) + interval '1 minute' AS run_to,
         (SELECT count(*) FROM "Candle" c WHERE c.symbol = e.symbol AND c.timeframe = 'M1'
            AND c."bucketStart" >= e.run_from AND c."bucketStart" < coalesce(e.run_end, 'infinity')) AS n_flat
  FROM ends e WHERE e.run_from IS NOT NULL
)
SELECT symbol, fri_close, run_from, run_to, n_flat, run_end AS first_real_bar,
       (SELECT open FROM "Candle" c WHERE c.symbol = runs.symbol AND c.timeframe = 'M1' AND c."bucketStart" = runs.run_end) AS first_real_open,
       CASE WHEN fri_close IS NULL THEN 'ABORT: no Friday close' WHEN run_to > o_to + interval '10 minutes' THEN 'ABORT: run too long'
            ELSE 'ok' END AS check
FROM runs ORDER BY symbol;
-- 0b. every bucket the cleanup would touch, now vs after, and the action
-- RUNS: each symbol's flat run, derived from the data (one definition, used by Step 0 and Step 1).
-- outer = the closed hours in UTC (only used to find where a run STARTS); fri_close = the last M1 close before them;
-- run_from = the first M1 in the closed hours that is flat at fri_close; run_end = the first M1 after it that is NOT
-- (the reopen); run_to = the last flat M1 before run_end + 1 minute.
WITH outer_w(symbol, o_from, o_to) AS (VALUES
  ('XAUUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('XAGUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('XPTUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('SpotCrude', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('SpotBrent', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-26 00:00+00')
), fri AS (
  SELECT o.*, (SELECT c.close FROM "Candle" c WHERE c.symbol = o.symbol AND c.timeframe = 'M1' AND c."bucketStart" < o.o_from
               ORDER BY c."bucketStart" DESC LIMIT 1) AS fri_close
  FROM outer_w o
), starts AS (
  SELECT f.*, (SELECT min(c."bucketStart") FROM "Candle" c WHERE c.symbol = f.symbol AND c.timeframe = 'M1'
                 AND c."bucketStart" >= f.o_from AND c."bucketStart" < f.o_to
                 AND c.open = f.fri_close AND c.high = f.fri_close AND c.low = f.fri_close AND c.close = f.fri_close) AS run_from
  FROM fri f
), ends AS (
  SELECT s.*, (SELECT min(c."bucketStart") FROM "Candle" c WHERE c.symbol = s.symbol AND c.timeframe = 'M1'
                 AND c."bucketStart" > s.run_from
                 AND NOT (c.open = s.fri_close AND c.high = s.fri_close AND c.low = s.fri_close AND c.close = s.fri_close)) AS run_end
  FROM starts s
), runs AS (
  SELECT e.symbol, e.o_from, e.o_to, e.fri_close, e.run_from, e.run_end,
         (SELECT max(c."bucketStart") FROM "Candle" c WHERE c.symbol = e.symbol AND c.timeframe = 'M1'
            AND c."bucketStart" >= e.run_from AND c."bucketStart" < coalesce(e.run_end, 'infinity')) + interval '1 minute' AS run_to,
         (SELECT count(*) FROM "Candle" c WHERE c.symbol = e.symbol AND c.timeframe = 'M1'
            AND c."bucketStart" >= e.run_from AND c."bucketStart" < coalesce(e.run_end, 'infinity')) AS n_flat
  FROM ends e WHERE e.run_from IS NOT NULL
)
SELECT r.symbol, c.timeframe, c."bucketStart", c.open AS open_now, c.high AS high_now, c.low AS low_now, c.close AS close_now,
       (array_agg(x.open ORDER BY x."bucketStart"))[1] AS open_new, max(x.high) AS high_new, min(x.low) AS low_new,
       (array_agg(x.close ORDER BY x."bucketStart" DESC))[1] AS close_new, count(x.*) AS real_m1_bars,
       CASE WHEN count(x.*) > 0 THEN 'rebuild'
            WHEN c.timeframe::text IN ('M5', 'M15', 'M30', 'H1')
                 AND c.open = r.fri_close AND c.high = r.fri_close AND c.low = r.fri_close AND c.close = r.fri_close THEN 'delete'
            ELSE 'skip' END AS action
FROM runs r
JOIN "Candle" c ON c.symbol = r.symbol AND c.timeframe IN ('M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1')
  AND c."bucketStart" < r.run_to AND c."bucketStart" + CASE c.timeframe::text WHEN 'M5' THEN interval '5 minutes' WHEN 'M15' THEN interval '15 minutes' WHEN 'M30' THEN interval '30 minutes' WHEN 'H1' THEN interval '1 hour' WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '24 hours' ELSE interval '168 hours' END > r.run_from
LEFT JOIN "Candle" x ON x.symbol = r.symbol AND x.timeframe = 'M1'
  AND x."bucketStart" >= c."bucketStart" AND x."bucketStart" < c."bucketStart" + CASE c.timeframe::text WHEN 'M5' THEN interval '5 minutes' WHEN 'M15' THEN interval '15 minutes' WHEN 'M30' THEN interval '30 minutes' WHEN 'H1' THEN interval '1 hour' WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '24 hours' ELSE interval '168 hours' END
  AND NOT (x."bucketStart" >= r.run_from AND x."bucketStart" < r.run_to)
GROUP BY r.symbol, r.fri_close, c.timeframe, c."bucketStart", c.open, c.high, c.low, c.close
ORDER BY r.symbol, c.timeframe, c."bucketStart";
COMMIT;

-- The owner sees Step 0 and says go. Then, engine stopped, back up the rows this can touch:
--   \copy (SELECT * FROM "Candle" WHERE symbol IN ('XAUUSD','XAGUSD','XPTUSD','SpotCrude','SpotBrent')
--          AND "bucketStart" >= '2026-10-17+00' AND "bucketStart" < '2026-10-27+00') TO 'C:\vyxtrader\backup\candle-2026-10-25-sunday.csv' CSV HEADER

-- ============================================================ Step 1: apply (engine stopped) ==================
BEGIN;
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE cleanup_runs ON COMMIT DROP AS
-- RUNS: each symbol's flat run, derived from the data (one definition, used by Step 0 and Step 1).
-- outer = the closed hours in UTC (only used to find where a run STARTS); fri_close = the last M1 close before them;
-- run_from = the first M1 in the closed hours that is flat at fri_close; run_end = the first M1 after it that is NOT
-- (the reopen); run_to = the last flat M1 before run_end + 1 minute.
WITH outer_w(symbol, o_from, o_to) AS (VALUES
  ('XAUUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('XAGUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('XPTUSD', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('SpotCrude', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-25 22:00+00'),
  ('SpotBrent', timestamptz '2026-10-25 21:00+00', timestamptz '2026-10-26 00:00+00')
), fri AS (
  SELECT o.*, (SELECT c.close FROM "Candle" c WHERE c.symbol = o.symbol AND c.timeframe = 'M1' AND c."bucketStart" < o.o_from
               ORDER BY c."bucketStart" DESC LIMIT 1) AS fri_close
  FROM outer_w o
), starts AS (
  SELECT f.*, (SELECT min(c."bucketStart") FROM "Candle" c WHERE c.symbol = f.symbol AND c.timeframe = 'M1'
                 AND c."bucketStart" >= f.o_from AND c."bucketStart" < f.o_to
                 AND c.open = f.fri_close AND c.high = f.fri_close AND c.low = f.fri_close AND c.close = f.fri_close) AS run_from
  FROM fri f
), ends AS (
  SELECT s.*, (SELECT min(c."bucketStart") FROM "Candle" c WHERE c.symbol = s.symbol AND c.timeframe = 'M1'
                 AND c."bucketStart" > s.run_from
                 AND NOT (c.open = s.fri_close AND c.high = s.fri_close AND c.low = s.fri_close AND c.close = s.fri_close)) AS run_end
  FROM starts s
), runs AS (
  SELECT e.symbol, e.o_from, e.o_to, e.fri_close, e.run_from, e.run_end,
         (SELECT max(c."bucketStart") FROM "Candle" c WHERE c.symbol = e.symbol AND c.timeframe = 'M1'
            AND c."bucketStart" >= e.run_from AND c."bucketStart" < coalesce(e.run_end, 'infinity')) + interval '1 minute' AS run_to,
         (SELECT count(*) FROM "Candle" c WHERE c.symbol = e.symbol AND c.timeframe = 'M1'
            AND c."bucketStart" >= e.run_from AND c."bucketStart" < coalesce(e.run_end, 'infinity')) AS n_flat
  FROM ends e WHERE e.run_from IS NOT NULL
)
SELECT * FROM runs;

-- 1a. the guard (rule 4): an implausible run aborts everything
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(symbol || CASE WHEN fri_close IS NULL THEN ' (no Friday close)' ELSE ' (run ends ' || run_to || ', past ' || o_to || ' + 10 min)' END, ', ')
    INTO bad FROM cleanup_runs WHERE fri_close IS NULL OR run_to > o_to + interval '10 minutes';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup refused: %; nothing changed', bad;
  END IF;
END $$;

-- 1b. the plan, computed before anything changes (same query as Step 0's 0b)
CREATE TEMP TABLE cleanup_plan ON COMMIT DROP AS
WITH runs AS (SELECT * FROM cleanup_runs)
SELECT r.symbol, c.timeframe, c."bucketStart", c.open AS open_now, c.high AS high_now, c.low AS low_now, c.close AS close_now,
       (array_agg(x.open ORDER BY x."bucketStart"))[1] AS open_new, max(x.high) AS high_new, min(x.low) AS low_new,
       (array_agg(x.close ORDER BY x."bucketStart" DESC))[1] AS close_new, count(x.*) AS real_m1_bars,
       CASE WHEN count(x.*) > 0 THEN 'rebuild'
            WHEN c.timeframe::text IN ('M5', 'M15', 'M30', 'H1')
                 AND c.open = r.fri_close AND c.high = r.fri_close AND c.low = r.fri_close AND c.close = r.fri_close THEN 'delete'
            ELSE 'skip' END AS action
FROM runs r
JOIN "Candle" c ON c.symbol = r.symbol AND c.timeframe IN ('M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1')
  AND c."bucketStart" < r.run_to AND c."bucketStart" + CASE c.timeframe::text WHEN 'M5' THEN interval '5 minutes' WHEN 'M15' THEN interval '15 minutes' WHEN 'M30' THEN interval '30 minutes' WHEN 'H1' THEN interval '1 hour' WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '24 hours' ELSE interval '168 hours' END > r.run_from
LEFT JOIN "Candle" x ON x.symbol = r.symbol AND x.timeframe = 'M1'
  AND x."bucketStart" >= c."bucketStart" AND x."bucketStart" < c."bucketStart" + CASE c.timeframe::text WHEN 'M5' THEN interval '5 minutes' WHEN 'M15' THEN interval '15 minutes' WHEN 'M30' THEN interval '30 minutes' WHEN 'H1' THEN interval '1 hour' WHEN 'H4' THEN interval '4 hours' WHEN 'D1' THEN interval '24 hours' ELSE interval '168 hours' END
  AND NOT (x."bucketStart" >= r.run_from AND x."bucketStart" < r.run_to)
GROUP BY r.symbol, r.fri_close, c.timeframe, c."bucketStart", c.open, c.high, c.low, c.close;

-- 1c. the flat M1 bars of each run: removed (the market was closed)
DELETE FROM "Candle" c USING cleanup_runs r
WHERE c.symbol = r.symbol AND c.timeframe = 'M1' AND c."bucketStart" >= r.run_from AND c."bucketStart" < r.run_to
  AND c.open = r.fri_close AND c.high = r.fri_close AND c.low = r.fri_close AND c.close = r.fri_close;
-- 1d. the coarser buckets: rebuilt from their real M1 bars, or removed when they are a flat M5-H1 bar, or left alone
DELETE FROM "Candle" c USING cleanup_plan p
WHERE p.action = 'delete' AND c.symbol = p.symbol AND c.timeframe = p.timeframe AND c."bucketStart" = p."bucketStart";
UPDATE "Candle" c SET open = p.open_new, high = p.high_new, low = p.low_new, close = p.close_new, "updatedAt" = now()
FROM cleanup_plan p
WHERE p.action = 'rebuild' AND c.symbol = p.symbol AND c.timeframe = p.timeframe AND c."bucketStart" = p."bucketStart";

-- 1e. what changed, for the record: check it, then COMMIT; anything unexpected: ROLLBACK
SELECT p.symbol, p.timeframe, p."bucketStart", p.action, c.open, c.high, c.low, c.close
FROM cleanup_plan p LEFT JOIN "Candle" c ON c.symbol = p.symbol AND c.timeframe = p.timeframe AND c."bucketStart" = p."bucketStart"
ORDER BY p.symbol, p.timeframe, p."bucketStart";
-- COMMIT;

-- ============================================================ Step 2: verify ==================================
-- 2a. Step 0 again: 0a lists no run (no flat bar left at a Friday close in the closed hours), 0b no bucket
-- 2b. each symbol's chart around Sunday 21:00-22:00 UTC: no flat line at Friday's close; the first bar is the reopen
