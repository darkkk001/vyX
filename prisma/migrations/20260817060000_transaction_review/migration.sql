-- AlterTable
-- "updatedAt" needs a backfill default since Transaction already has
-- rows (TRADE_PNL, ADJUSTMENT) -- every existing row's "updated" instant
-- becomes "now" (the moment this migration runs), which is correct: they
-- were never actually updated after creation, so this is the first true
-- update timestamp for all of them.
ALTER TABLE "Transaction" ADD COLUMN "reviewedByAdminId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
