-- Equity history for the backoffice balance/equity chart (bo 1.0.96 #21, owner 2026-10-27: snapshots from now on; only
-- accounts with an open position, only when the equity changed). Additive: a new empty table, nothing else touched.
-- Revert: DROP TABLE "AccountEquitySnapshot";
CREATE TABLE "AccountEquitySnapshot" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "equity" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "credit" DECIMAL(18,2) NOT NULL,
    "floating" DECIMAL(18,2) NOT NULL,
    CONSTRAINT "AccountEquitySnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccountEquitySnapshot_accountId_at_idx" ON "AccountEquitySnapshot"("accountId", "at");
CREATE INDEX "AccountEquitySnapshot_at_idx" ON "AccountEquitySnapshot"("at");
ALTER TABLE "AccountEquitySnapshot" ADD CONSTRAINT "AccountEquitySnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
