-- Neon -> VPS candle migration, stage S2: the market-data store's schema.
--
-- Run once on the Contabo box, as the postgres superuser, AFTER
-- `CREATE DATABASE market_data` (see deploy/market-data-vps-runbook.md):
--
--     psql -U postgres -d market_data -f market_data.sql
--
-- Column names, types and the primary keys are byte-identical to the two
-- Prisma models in prisma/schema.prisma (Candle, LivePrice) as they exist
-- on Neon today, so:
--   * engine/market-data's existing upserts (db.rs) run unchanged against
--     this database,
--   * `pg_dump --data-only` output from Neon restores here without edits,
--   * `GET /internal/candles` returns the same JSON the Prisma route did.
-- Prisma never manages this database (no _prisma_migrations table) -- it
-- is the engine's own store; schema changes land here by hand, mirrored
-- from the Prisma migration that changes the Neon side.
--
-- Idempotent: safe to re-run.

DO $$ BEGIN
    CREATE ROLE engine LOGIN PASSWORD 'CHANGE-ME-BEFORE-RUNNING';  -- edit here, or ALTER ROLE engine PASSWORD '...' afterwards
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "CandleTimeframe" AS ENUM ('M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1', 'Y1');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Candle" (
    "symbol"      TEXT              NOT NULL,
    "timeframe"   "CandleTimeframe" NOT NULL,
    "bucketStart" TIMESTAMPTZ(3)    NOT NULL,
    "open"        DECIMAL(18,5)     NOT NULL,
    "high"        DECIMAL(18,5)     NOT NULL,
    "low"         DECIMAL(18,5)     NOT NULL,
    "close"       DECIMAL(18,5)     NOT NULL,
    "updatedAt"   TIMESTAMPTZ(3)    NOT NULL,
    CONSTRAINT "Candle_pkey" PRIMARY KEY ("symbol", "timeframe", "bucketStart")
);

CREATE TABLE IF NOT EXISTS "LivePrice" (
    "symbol"    TEXT           NOT NULL,
    "bid"       DECIMAL(18,5)  NOT NULL,
    "ask"       DECIMAL(18,5)  NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "tickAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "LivePrice_pkey" PRIMARY KEY ("symbol")
);

GRANT CONNECT ON DATABASE market_data TO engine;
GRANT USAGE ON SCHEMA public TO engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Candle", "LivePrice" TO engine;
