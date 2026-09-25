-- Rust cutover Stage 5: the shadow store on the VPS's LOCAL Postgres (database market_data), run ONCE as postgres:
--   psql -U postgres -h 127.0.0.1 -d market_data -f deploy\shadow-store.sql
-- The engine role (deploy/market_data.sql: USAGE on public only) cannot CREATE tables; the engine accepts these
-- tables when it finds them. Idempotent. Nothing here touches Neon.
CREATE TABLE IF NOT EXISTS shadow_decision (
  id            BIGSERIAL PRIMARY KEY,
  dedupe_key    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  position_id   TEXT,
  level_before  NUMERIC,
  level         NUMERIC,
  close_price   NUMERIC,
  pnl           NUMERIC,
  balance_after NUMERIC,
  credit_after  NUMERIC,
  write_off     NUMERIC,
  prices        JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS shadow_decision_first_seen ON shadow_decision (first_seen);
CREATE INDEX IF NOT EXISTS shadow_decision_position ON shadow_decision (position_id);
CREATE TABLE IF NOT EXISTS shadow_pair (
  id            BIGSERIAL PRIMARY KEY,
  class         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  position_id   TEXT,
  web_ref       TEXT UNIQUE,
  decision_key  TEXT UNIQUE,
  web_at        TIMESTAMPTZ,
  shadow_at     TIMESTAMPTZ,
  skew_ms       BIGINT,
  known_fan_in  BOOLEAN NOT NULL DEFAULT false,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shadow_pair_created ON shadow_pair (created_at);
CREATE TABLE IF NOT EXISTS shadow_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_daily (
  day            DATE PRIMARY KEY,
  counts         JSONB NOT NULL,
  skew_p50_ms    BIGINT,
  skew_p95_ms    BIGINT,
  skew_max_ms    BIGINT,
  paired_total   BIGINT NOT NULL,
  clock_days     NUMERIC NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- soak exit gate (2026-09-25): weekend reopens / NFP windows lived through, and the verdict
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS weekend_opens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS nfp_windows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS exit_met BOOLEAN NOT NULL DEFAULT false;

GRANT SELECT, INSERT, UPDATE, DELETE ON shadow_decision, shadow_pair, shadow_state, shadow_daily TO engine;
GRANT USAGE, SELECT ON SEQUENCE shadow_decision_id_seq, shadow_pair_id_seq TO engine;
