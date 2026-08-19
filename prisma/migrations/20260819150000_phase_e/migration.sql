-- Phase E: Liquidity (pre-integration record-keeping only).

CREATE TYPE "LpStatus" AS ENUM ('PROSPECTIVE', 'NEGOTIATING', 'CONTRACTED', 'CONNECTED');

CREATE TABLE "LiquidityProvider" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "protocol" TEXT,
    "status" "LpStatus" NOT NULL DEFAULT 'PROSPECTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LiquidityProvider_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LiquidityProvider_brokerId_idx" ON "LiquidityProvider"("brokerId");

ALTER TABLE "LiquidityProvider" ADD CONSTRAINT "LiquidityProvider_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "LpRoutingRule" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "liquidityProviderId" TEXT NOT NULL,
    "symbolId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LpRoutingRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LpRoutingRule_brokerId_idx" ON "LpRoutingRule"("brokerId");
CREATE INDEX "LpRoutingRule_liquidityProviderId_idx" ON "LpRoutingRule"("liquidityProviderId");

ALTER TABLE "LpRoutingRule" ADD CONSTRAINT "LpRoutingRule_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LpRoutingRule" ADD CONSTRAINT "LpRoutingRule_liquidityProviderId_fkey" FOREIGN KEY ("liquidityProviderId") REFERENCES "LiquidityProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LpRoutingRule" ADD CONSTRAINT "LpRoutingRule_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE SET NULL ON UPDATE CASCADE;
