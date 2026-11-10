-- Credit-out on withdrawal (owner 2026-11-10): per broker, on by default. Additive: one column with a default.
-- Revert: ALTER TABLE "Broker" DROP COLUMN "voidCreditOnWithdrawal";
ALTER TABLE "Broker" ADD COLUMN "voidCreditOnWithdrawal" BOOLEAN NOT NULL DEFAULT true;
