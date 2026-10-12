-- Step 3b item 6 (owner 2026-10-07): Risk radar flag / whitelist / note per account. New table only.
CREATE TABLE "RiskAccountMark" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "whitelisted" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RiskAccountMark_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RiskAccountMark_accountId_key" ON "RiskAccountMark"("accountId");
CREATE INDEX "RiskAccountMark_brokerId_idx" ON "RiskAccountMark"("brokerId");

ALTER TABLE "RiskAccountMark" ADD CONSTRAINT "RiskAccountMark_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
