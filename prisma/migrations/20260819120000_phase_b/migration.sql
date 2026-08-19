-- Phase B: Leads, Trading Sessions, Internal Transfers.

-- TransactionType: internal-transfer debit/credit sides.
ALTER TYPE "TransactionType" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "TransactionType" ADD VALUE 'TRANSFER_IN';

-- LeadStatus
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST');

-- Lead
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "country" TEXT,
    "source" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "convertedAccountId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Lead_convertedAccountId_key" ON "Lead"("convertedAccountId");
CREATE INDEX "Lead_brokerId_idx" ON "Lead"("brokerId");

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_convertedAccountId_fkey" FOREIGN KEY ("convertedAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- TradingSession
CREATE TABLE "TradingSession" (
    "id" TEXT NOT NULL,
    "brokerSymbolId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "openTime" TEXT NOT NULL,
    "closeTime" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TradingSession_brokerSymbolId_idx" ON "TradingSession"("brokerSymbolId");

ALTER TABLE "TradingSession" ADD CONSTRAINT "TradingSession_brokerSymbolId_fkey" FOREIGN KEY ("brokerSymbolId") REFERENCES "BrokerSymbol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
