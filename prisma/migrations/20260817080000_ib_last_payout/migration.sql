-- AlterTable
-- Additive, nullable column -- safe regardless of existing IbRelationship
-- row count. Null means "never paid" (pending commission computed on
-- read from Position rows, not stored).
ALTER TABLE "IbRelationship" ADD COLUMN "lastPayoutAt" TIMESTAMPTZ(3);
