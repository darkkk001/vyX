-- Phase 1 trust pack §3 -- real, server-evaluated price alerts (see
-- PriceAlert's own schema comment for why this replaces WebTrader.tsx's
-- old client-side-only mock).
CREATE TYPE "AlertCondition" AS ENUM ('ABOVE', 'BELOW', 'CROSSES');
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'TRIGGERED', 'EXPIRED', 'CANCELLED');

CREATE TABLE "PriceAlert" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "condition" "AlertCondition" NOT NULL,
    "price" DECIMAL(18,5) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "triggeredAt" TIMESTAMPTZ(3),
    "triggeredPrice" DECIMAL(18,5),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PriceAlert_brokerId_symbol_status_idx" ON "PriceAlert"("brokerId", "symbol", "status");
CREATE INDEX "PriceAlert_accountId_idx" ON "PriceAlert"("accountId");

ALTER TABLE "PriceAlert" ADD CONSTRAINT "PriceAlert_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceAlert" ADD CONSTRAINT "PriceAlert_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- First trader-facing Notification -- see that model's own updated
-- schema comment. Nullable, additive; every existing row/type is
-- unaffected.
ALTER TABLE "Notification" ADD COLUMN "accountId" TEXT;
CREATE INDEX "Notification_accountId_idx" ON "Notification"("accountId");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
