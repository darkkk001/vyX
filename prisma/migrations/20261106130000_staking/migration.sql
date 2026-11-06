-- Staking, off for every broker. Additive.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'STAKE_OUT';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'STAKING_RETURN';
CREATE TYPE "StakeStatus" AS ENUM ('ACTIVE', 'PAID');
ALTER TABLE "Broker" ADD COLUMN "stakingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Broker" ADD COLUMN "stakingMinAmount" DECIMAL(18,2) NOT NULL DEFAULT 1000;
ALTER TABLE "Broker" ADD COLUMN "stakingCycleDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "Broker" ADD COLUMN "stakingRatePct" DECIMAL(6,3) NOT NULL DEFAULT 10;
CREATE TABLE "Stake" (
  "id" TEXT NOT NULL,
  "brokerId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "ratePct" DECIMAL(6,3) NOT NULL,
  "cycleDays" INTEGER NOT NULL,
  "returnAmount" DECIMAL(18,2) NOT NULL,
  "status" "StakeStatus" NOT NULL DEFAULT 'ACTIVE',
  "startAt" TIMESTAMPTZ(3) NOT NULL,
  "endAt" TIMESTAMPTZ(3) NOT NULL,
  "paidAt" TIMESTAMPTZ(3),
  "openTransactionId" TEXT NOT NULL,
  "payoutTransactionId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Stake_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Stake_brokerId_status_idx" ON "Stake"("brokerId", "status");
CREATE INDEX "Stake_clientId_idx" ON "Stake"("clientId");
CREATE INDEX "Stake_status_endAt_idx" ON "Stake"("status", "endAt");
ALTER TABLE "Stake" ADD CONSTRAINT "Stake_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Stake" ADD CONSTRAINT "Stake_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Stake" ADD CONSTRAINT "Stake_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
