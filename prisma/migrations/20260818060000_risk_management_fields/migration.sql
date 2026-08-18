-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('BOTH', 'BUY_ONLY', 'SELL_ONLY');

-- AlterTable
-- Additive, nullable columns -- safe regardless of existing Broker rows.
-- tradingHaltedAt non-null = reject all new orders broker-wide (see
-- lib/risk.ts's checkTradingHalted). totalExposureLimit = sum of open
-- volume across every symbol for this broker (checkBrokerExposure).
ALTER TABLE "Broker" ADD COLUMN     "tradingHaltedAt" TIMESTAMPTZ(3);
ALTER TABLE "Broker" ADD COLUMN     "totalExposureLimit" DECIMAL(18,2);

-- AlterTable
-- Null = no limit. See lib/risk.ts's checkMaxDailyLoss.
ALTER TABLE "Account" ADD COLUMN     "maxDailyLoss" DECIMAL(18,2);

-- AlterTable
-- Additive, defaulted column -- safe regardless of existing BrokerSymbol
-- rows. See lib/risk.ts's checkSymbolTradingMode.
ALTER TABLE "BrokerSymbol" ADD COLUMN     "tradingMode" "TradingMode" NOT NULL DEFAULT 'BOTH';
