-- Slippage cap per broker (owner 2026-10-26, lib/slippage-cap.ts). Additive: two broker columns with defaults, one enum,
-- one nullable per-symbol override. Every broker starts at the approved default: 30 XAUUSD points, REQUOTE.
-- The old broker-wide defaultMaxSlippagePoints / Pips stay (backoffice 1.0.95 and older still send them; the risk route
-- now writes them through to slippageCapXauPoints) and are no longer read for fills.
-- Revert: ALTER TABLE "BrokerSymbol" DROP COLUMN "maxSlippagePoints";
--   ALTER TABLE "Broker" DROP COLUMN "slippageAction", DROP COLUMN "slippageCapRefPrice", DROP COLUMN "slippageCapXauPoints";
--   DROP TYPE "SlippageAction";
CREATE TYPE "SlippageAction" AS ENUM ('REQUOTE', 'REJECT');
ALTER TABLE "Broker"
  ADD COLUMN "slippageCapXauPoints" DECIMAL(10,2) DEFAULT 30,
  ADD COLUMN "slippageCapRefPrice" DECIMAL(18,5) DEFAULT 4000,
  ADD COLUMN "slippageAction" "SlippageAction" NOT NULL DEFAULT 'REQUOTE';
ALTER TABLE "BrokerSymbol" ADD COLUMN "maxSlippagePoints" DECIMAL(10,2);
