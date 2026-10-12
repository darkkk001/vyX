-- Step 3b item 2 (owner 2026-10-07): four broker settings. All additive; every default keeps today's behaviour.
ALTER TABLE "Broker" ADD COLUMN "sessionTimeoutMinutes" INTEGER;
ALTER TABLE "Broker" ADD COLUMN "auditRetentionDays" INTEGER;
ALTER TABLE "Broker" ADD COLUMN "autoApproveWithdrawalMax" DECIMAL(18,2);
ALTER TABLE "Broker" ADD COLUMN "hedgingAllowed" BOOLEAN NOT NULL DEFAULT true;
