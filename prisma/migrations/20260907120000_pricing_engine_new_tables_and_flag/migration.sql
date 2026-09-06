-- Phase 2 pricing engine, Stage 1a: purely new objects -- two new tables
-- and one new Broker column, nothing existing is altered. Broker.
-- pricingEngineEnabled defaults false and nothing reads it yet.

-- CreateTable
CREATE TABLE "AccountTypeSymbolConfig" (
    "id" TEXT NOT NULL,
    "accountTypeId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "spreadMarkup" DECIMAL(10,4),
    "targetTotalSpreadPips" DECIMAL(10,4),
    "commissionPerLot" DECIMAL(10,2),
    "swapLong" DECIMAL(10,4),
    "swapShort" DECIMAL(10,4),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountTypeSymbolConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSymbolConfig" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "spreadMarkup" DECIMAL(10,4),
    "targetTotalSpreadPips" DECIMAL(10,4),
    "commissionPerLot" DECIMAL(10,2),
    "swapLong" DECIMAL(10,4),
    "swapShort" DECIMAL(10,4),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountSymbolConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountTypeSymbolConfig_accountTypeId_idx" ON "AccountTypeSymbolConfig"("accountTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountTypeSymbolConfig_accountTypeId_symbolId_key" ON "AccountTypeSymbolConfig"("accountTypeId", "symbolId");

-- CreateIndex
CREATE INDEX "AccountSymbolConfig_accountId_idx" ON "AccountSymbolConfig"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountSymbolConfig_accountId_symbolId_key" ON "AccountSymbolConfig"("accountId", "symbolId");

-- AddForeignKey
ALTER TABLE "AccountTypeSymbolConfig" ADD CONSTRAINT "AccountTypeSymbolConfig_accountTypeId_fkey" FOREIGN KEY ("accountTypeId") REFERENCES "AccountType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountTypeSymbolConfig" ADD CONSTRAINT "AccountTypeSymbolConfig_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSymbolConfig" ADD CONSTRAINT "AccountSymbolConfig_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSymbolConfig" ADD CONSTRAINT "AccountSymbolConfig_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Broker" ADD COLUMN     "pricingEngineEnabled" BOOLEAN NOT NULL DEFAULT false;
