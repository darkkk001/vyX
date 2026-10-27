-- S8 (tools/shadow-bot/scenarios/s8-stopout-contention.json) match-run capture. Copy it to the VPS with (PowerShell; the
-- checkout's remote for this repo may not be called origin: git -C C:\vyxtrader\repo remote -v):
--   git -C C:\vyxtrader\repo fetch origin shadow-bot
--   git -C C:\vyxtrader\repo show origin/shadow-bot:tools/shadow-bot/sql/stopout-contention-capture.sql | Set-Content C:\vyxtrader\handoff\stopout-contention-capture.sql -Encoding UTF8
-- (not `>`: Windows PowerShell 5.1 writes UTF-16, which psql cannot read). Set the two windows below, then psql -X -f.
-- Changes nothing (temp views, rolled back). Part A before / after (owner 2026-10-27): does a stop-out still wait behind SL / TP work?
-- Run once after BOTH match-runs (S8 on the old engine, S8 on the new one, the same scenario commit), with the two windows set below.
-- The same load both times: the same tool, accounts, position count and price path.
BEGIN;  -- not READ ONLY: the temp views need a write; ROLLBACK at the end leaves nothing
SET LOCAL TIME ZONE 'UTC';

CREATE TEMP VIEW w AS
SELECT * FROM (VALUES
  ('before', '<before start UTC>'::timestamptz, '<before end UTC>'::timestamptz),   -- <-- SET: the S8 run on the old engine (from its journal: run.start .. run.end)
  ('after',  '<after start UTC>'::timestamptz,  '<after end UTC>'::timestamptz)     -- <-- SET: the S8 run on the new engine; an unset window is a syntax error, never a silent wrong window
) v(run, t_from, t_to);

CREATE TEMP VIEW c AS
SELECT w.run, e."accountId" AS account_id, e.reason,
       e.payload->>'triggerSource' AS source,
       (e.payload->>'engineDelayMs')::numeric AS delay_ms,
       (e.payload->>'triggerTickEngineAt')::timestamptz AS tick_engine_at,
       (e.payload->>'closeEngineAt')::timestamptz AS close_engine_at
FROM "PostCloseEffect" e JOIN w ON e."createdAt" BETWEEN w.t_from AND w.t_to
WHERE e.kind = 'POSITION_CLOSED' AND e.payload ? 'triggerSource';

-- the FIRST stop-out close of each account per episode (a new episode = more than 60 s after its previous stop-out close)
CREATE TEMP VIEW s AS
SELECT * FROM (
  SELECT c.*, lag(close_engine_at) OVER (PARTITION BY run, account_id ORDER BY close_engine_at) AS prev_close
  FROM c WHERE reason = 'stop_out'
) x WHERE prev_close IS NULL OR close_engine_at - prev_close > interval '60 seconds';

-- 1. the headline: crossing tick -> first stop-out close, and how many SL / TP closes of OTHER accounts were written in between
--    (before: the stop-out waits for them; after: about none)
SELECT s.run, count(*) AS stop_outs,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.delay_ms)::numeric) AS delay_p50_ms,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.delay_ms)::numeric) AS delay_p95_ms,
       max(s.delay_ms) AS delay_max_ms,
       round(avg(ahead.n), 1) AS sl_tp_closes_ahead_avg, max(ahead.n) AS sl_tp_closes_ahead_max,
       count(*) FILTER (WHERE s.delay_ms > 1000) AS over_1s
FROM s
CROSS JOIN LATERAL (
  SELECT count(*) AS n FROM c o
  WHERE o.run = s.run AND o.account_id <> s.account_id AND o.reason IN ('stop_loss', 'take_profit')
    AND o.close_engine_at > s.tick_engine_at AND o.close_engine_at < s.close_engine_at
) ahead
GROUP BY s.run ORDER BY s.run DESC;

-- 2. was there SL / TP load at all? (a match-run without it proves nothing): closes per reason and their delay
SELECT run, reason, source, count(*) AS n,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY delay_ms)::numeric) AS delay_p50_ms,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY delay_ms)::numeric) AS delay_p95_ms,
       max(delay_ms) AS delay_max_ms
FROM c GROUP BY run, reason, source ORDER BY run DESC, n DESC;

-- 3. every stop-out episode, for the record
SELECT s.run, s.account_id, s.tick_engine_at, s.close_engine_at, s.delay_ms,
       (SELECT count(*) FROM c o WHERE o.run = s.run AND o.account_id = s.account_id AND o.reason = 'stop_out'
          AND o.close_engine_at BETWEEN s.close_engine_at AND s.close_engine_at + interval '60 seconds') AS closes_in_episode
FROM s ORDER BY s.run DESC, s.tick_engine_at;
ROLLBACK;
