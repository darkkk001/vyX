-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'NEGATIVE_BALANCE_PROTECTION';

-- AlterTable
ALTER TABLE "Broker" ADD COLUMN     "negativeBalanceProtection" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "marginCallNotifiedAt" TIMESTAMPTZ(3);
