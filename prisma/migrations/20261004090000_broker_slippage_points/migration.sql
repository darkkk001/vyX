-- D4/slippage batch (owner 2026-09-30): the broker's max-slippage cap stored in POINTS, the unit every screen shows.
-- Additive only: one nullable column. The data step (points = pips x 10) is NOT in this migration: it is a separate,
-- previewed, audited write (deploy/d4-slippage-runbook.md). Until it runs, every reader falls back to pips x 10, so
-- behaviour is identical before and after this migration. "defaultMaxSlippagePips" is kept (and written alongside)
-- until the conversion is verified.
ALTER TABLE "Broker" ADD COLUMN IF NOT EXISTS "defaultMaxSlippagePoints" DECIMAL(10, 2);
