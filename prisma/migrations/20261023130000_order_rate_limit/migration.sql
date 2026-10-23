-- Order rate limit per account (owner 2026-10-23, docs/ORDER-RATE-LIMIT-DESIGN.md): per-broker overrides of the
-- platform default. Additive, nullable, no rows written: null = the default (burst 100, 600 per minute), 0 = off.
-- Revert: ALTER TABLE "Broker" DROP COLUMN "orderBurst", DROP COLUMN "orderPerMinute";
ALTER TABLE "Broker" ADD COLUMN "orderBurst" INTEGER, ADD COLUMN "orderPerMinute" INTEGER;
ALTER TABLE "Broker" ADD CONSTRAINT "Broker_orderBurst_nonneg" CHECK ("orderBurst" IS NULL OR "orderBurst" >= 0);
ALTER TABLE "Broker" ADD CONSTRAINT "Broker_orderPerMinute_nonneg" CHECK ("orderPerMinute" IS NULL OR "orderPerMinute" >= 0);
