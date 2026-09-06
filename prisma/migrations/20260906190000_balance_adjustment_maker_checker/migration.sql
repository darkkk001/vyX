-- CreateEnum
CREATE TYPE "BalanceAdjustmentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "BalanceAdjustmentRequest" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT NOT NULL,
    "status" "BalanceAdjustmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByAdminId" TEXT NOT NULL,
    "reviewedByAdminId" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BalanceAdjustmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BalanceAdjustmentRequest_brokerId_idx" ON "BalanceAdjustmentRequest"("brokerId");

-- CreateIndex
CREATE INDEX "BalanceAdjustmentRequest_accountId_idx" ON "BalanceAdjustmentRequest"("accountId");

-- CreateIndex
CREATE INDEX "BalanceAdjustmentRequest_status_idx" ON "BalanceAdjustmentRequest"("status");

-- AddForeignKey
ALTER TABLE "BalanceAdjustmentRequest" ADD CONSTRAINT "BalanceAdjustmentRequest_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceAdjustmentRequest" ADD CONSTRAINT "BalanceAdjustmentRequest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceAdjustmentRequest" ADD CONSTRAINT "BalanceAdjustmentRequest_requestedByAdminId_fkey" FOREIGN KEY ("requestedByAdminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceAdjustmentRequest" ADD CONSTRAINT "BalanceAdjustmentRequest_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
