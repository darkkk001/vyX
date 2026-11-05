-- Symbols tab server part (backoffice 1.0.101). Additive only: new enums, new nullable columns,
-- TradingSession.kind with DEFAULT 'TRADE' (existing rows stay trading windows).

ALTER TYPE "TradingMode" ADD VALUE 'CLOSE_ONLY';

CREATE TYPE "SymbolExecutionMode" AS ENUM ('MARKET', 'INSTANT');
CREATE TYPE "FillPolicy" AS ENUM ('FOK', 'IOC');
CREATE TYPE "SwapType" AS ENUM ('POINTS', 'PERCENT', 'MONEY');
CREATE TYPE "SessionKind" AS ENUM ('TRADE', 'QUOTE');

ALTER TABLE "Broker" ADD COLUMN "timeZone" TEXT;

ALTER TABLE "BrokerSymbol"
  ADD COLUMN "tickSize" DECIMAL(18,10),
  ADD COLUMN "tickValue" DECIMAL(18,6),
  ADD COLUMN "marginCurrency" TEXT,
  ADD COLUMN "profitCurrency" TEXT,
  ADD COLUMN "executionMode" "SymbolExecutionMode",
  ADD COLUMN "fillPolicy" "FillPolicy",
  ADD COLUMN "swapType" "SwapType",
  ADD COLUMN "tripleSwapDay" INTEGER,
  ADD COLUMN "freezeLevel" INTEGER,
  ADD COLUMN "marginInitial" DECIMAL(10,4),
  ADD COLUMN "marginMaintenance" DECIMAL(10,4),
  ADD COLUMN "description" TEXT,
  ADD COLUMN "displayOrder" INTEGER;

ALTER TABLE "TradingSession" ADD COLUMN "kind" "SessionKind" NOT NULL DEFAULT 'TRADE';
