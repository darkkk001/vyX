-- Audit 2026-09-24 Batch 4 (owner decision, line 8): partner commission is fixed at each trade's close. Additive only:
-- two columns with defaults; no existing value changes (accruedThrough NULL = count from lastPayoutAt, as today).
ALTER TABLE "IbRelationship" ADD COLUMN "accruedUnpaid" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "accruedThrough" TIMESTAMPTZ(3);
