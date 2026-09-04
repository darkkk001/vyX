-- Active chart indicators (per-account, JSON blob) -- see
-- Account.chartIndicators's own schema comment.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "chartIndicators" JSONB;
