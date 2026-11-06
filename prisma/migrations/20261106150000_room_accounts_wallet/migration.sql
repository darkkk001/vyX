-- Trader's Room accounts: nickname, archive, read-only password, funding wallet. Additive.
ALTER TABLE "Account" ADD COLUMN "nickname" TEXT;
ALTER TABLE "Account" ADD COLUMN "archivedAt" TIMESTAMPTZ(3);
ALTER TABLE "Account" ADD COLUMN "investorPasswordHash" TEXT;
ALTER TABLE "Account" ADD COLUMN "isWallet" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LiveAccountRequest" ADD COLUMN "requestedNickname" TEXT;
ALTER TABLE "LiveAccountRequest" ADD COLUMN "requestedPasswordHash" TEXT;

-- one funding wallet per client, whatever races
CREATE UNIQUE INDEX "Account_one_wallet_per_client" ON "Account" ("clientId") WHERE "isWallet" = true;
