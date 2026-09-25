-- Audit 2026-09-24 Batch 2 (owner decision D5): per-broker withdrawal approval mode, and maker-checker request kinds
-- for transfers and IB payouts. Additive only: two enums, four columns with defaults / nullable, two FKs.

-- CreateEnum
CREATE TYPE "WithdrawalApproval" AS ENUM ('SINGLE', 'DUAL');

-- CreateEnum
CREATE TYPE "BalanceRequestKind" AS ENUM ('ADJUSTMENT', 'TRANSFER', 'IB_PAYOUT');

-- AlterTable: every broker starts on DUAL (today's behaviour)
ALTER TABLE "Broker" ADD COLUMN "withdrawalApproval" "WithdrawalApproval" NOT NULL DEFAULT 'DUAL';

-- AlterTable: every existing request is an ADJUSTMENT (today's only kind)
ALTER TABLE "BalanceAdjustmentRequest" ADD COLUMN "kind" "BalanceRequestKind" NOT NULL DEFAULT 'ADJUSTMENT',
ADD COLUMN "toAccountId" TEXT,
ADD COLUMN "ibRelationshipId" TEXT;

-- AddForeignKey
ALTER TABLE "BalanceAdjustmentRequest" ADD CONSTRAINT "BalanceAdjustmentRequest_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceAdjustmentRequest" ADD CONSTRAINT "BalanceAdjustmentRequest_ibRelationshipId_fkey" FOREIGN KEY ("ibRelationshipId") REFERENCES "IbRelationship"("id") ON DELETE SET NULL ON UPDATE CASCADE;
