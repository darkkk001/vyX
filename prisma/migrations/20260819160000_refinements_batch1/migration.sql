-- Refinements batch 1: maker-checker withdrawals, per-group risk overrides, position void.

ALTER TABLE "Transaction" ADD COLUMN "markedByAdminId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "markedAt" TIMESTAMPTZ(3);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_markedByAdminId_fkey" FOREIGN KEY ("markedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Group" ADD COLUMN "maxLotSize" DECIMAL(10,2);
ALTER TABLE "Group" ADD COLUMN "tradingRestriction" "TradingMode" NOT NULL DEFAULT 'BOTH';
ALTER TABLE "Group" ADD COLUMN "swapFree" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "PositionStatus" ADD VALUE 'VOIDED';
