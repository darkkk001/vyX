-- Credit add / remove and per-account trading rights (2026-09-28).
--
-- 1. "TradingRights" enum + Account."tradingRights" (default FULL = today's behaviour for every existing account).
--    Enforced by lib/risk.ts checkAccountTradingRights at every order gate.
-- 2. TransactionType CREDIT_IN / CREDIT_OUT: the ledger rows of staff adding / removing Credit ($)
--    (lib/credit-adjustment.ts). The existing CREDIT value keeps its meaning (credit used up by a closing loss).
-- 3. BalanceRequestKind CREDIT: a MANAGER's credit change waits in the same maker-checker queue as a balance adjustment.
--
-- Additive only. The new enum values are not used inside this migration (Postgres forbids using a value added in the
-- same transaction).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TradingRights') THEN
    CREATE TYPE "TradingRights" AS ENUM ('FULL', 'CLOSE_ONLY', 'READ_ONLY');
  END IF;
END $$;

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "tradingRights" "TradingRights" NOT NULL DEFAULT 'FULL';

ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'CREDIT_IN';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'CREDIT_OUT';
ALTER TYPE "BalanceRequestKind" ADD VALUE IF NOT EXISTS 'CREDIT';

DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM "Account" WHERE "tradingRights" <> 'FULL';
  RAISE NOTICE 'accounts not FULL after migration: % (expect 0)', n;
END $$;
