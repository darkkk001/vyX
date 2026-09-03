-- Client cabinet Funds UI (VYX-FUNDS-V0): provider-agnostic PSP adapter
-- data model -- PaymentMethod (backoffice-configured per broker),
-- SavedWithdrawalAddress (trader's saved crypto destinations), and
-- additive Transaction columns tracking which adapter/method serviced a
-- request and its own sub-status. Schema-only groundwork, same pattern
-- as this project's other schema-first commits (PositionActionRequest,
-- EconomicCalendarCache) -- the adapters/routes/UI land in a follow-up.
--
-- Hand-picked from `prisma migrate diff` against the live DB -- NOT
-- applied verbatim, since that diff also contained a pile of unrelated
-- pre-existing drift (the Rust engine's own snake_case tables reading as
-- droppable, column-type nits elsewhere) -- see this project's own
-- migrate-dev gotcha: never trust the raw diff wholesale on this DB.

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('USDT_TRC20', 'USDT_BEP20', 'BTC', 'ETH', 'BANK_TRANSFER');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "confirmations" INTEGER,
ADD COLUMN     "destinationAddress" TEXT,
ADD COLUMN     "paymentMethodId" TEXT,
ADD COLUMN     "pspAdapter" TEXT,
ADD COLUMN     "pspReference" TEXT,
ADD COLUMN     "pspStatus" TEXT,
ADD COLUMN     "receiptDataUrl" TEXT;

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "type" "PaymentMethodType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "maxAmount" DECIMAL(18,2),
    "feePercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "feeFixed" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "instructions" TEXT,
    "walletAddress" TEXT,
    "pspProvider" TEXT,
    "pspApiKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedWithdrawalAddress" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "PaymentMethodType" NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedWithdrawalAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentMethod_brokerId_idx" ON "PaymentMethod"("brokerId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_brokerId_type_key" ON "PaymentMethod"("brokerId", "type");

-- CreateIndex
CREATE INDEX "SavedWithdrawalAddress_accountId_idx" ON "SavedWithdrawalAddress"("accountId");

-- CreateIndex
CREATE INDEX "Transaction_paymentMethodId_idx" ON "Transaction"("paymentMethodId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedWithdrawalAddress" ADD CONSTRAINT "SavedWithdrawalAddress_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
