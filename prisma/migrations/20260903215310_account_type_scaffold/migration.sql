-- AccountType scaffold (approved spec, 2026-09-04):
--   1. Rename Account.accountType (DEMO/LIVE) -> Account.accountMode, and
--      the backing enum AccountType -> AccountMode, freeing the name
--      "AccountType" for the new pricing-tier model below (Postgres
--      would not allow a table and an enum type to share one name in
--      the same schema).
--   2. New AccountType table (per-broker pricing-tier label: Standard/
--      Pro/Zero seeded for every existing broker), Account.accountTypeId
--      FK, every existing account backfilled to its broker's isDefault
--      type.
-- Hand-written, not `prisma migrate dev` output -- this DB's Rust-engine
-- tables (ledger_entries/orders/positions, snake_case) always show up as
-- unrelated drift in a raw diff; excluded here per this project's own
-- established migration convention (see prisma/migrations' own history).

-- 1a. New enum, add nullable accountMode column, backfill from the old
-- enum by text-casting (identical labels), then require it.
CREATE TYPE "AccountMode" AS ENUM ('DEMO', 'LIVE');

ALTER TABLE "Account" ADD COLUMN "accountMode" "AccountMode";
UPDATE "Account" SET "accountMode" = "accountType"::text::"AccountMode";
ALTER TABLE "Account" ALTER COLUMN "accountMode" SET NOT NULL;

-- 1b. Drop the old column/index/enum -- the enum must go before the new
-- AccountType TABLE is created below, since a table and a type can't
-- share a name.
DROP INDEX "Account_brokerId_email_accountType_key";
ALTER TABLE "Account" DROP COLUMN "accountType";
DROP TYPE "AccountType";

CREATE UNIQUE INDEX "Account_brokerId_email_accountMode_key" ON "Account"("brokerId", "email", "accountMode");

-- 2a. New AccountType table.
CREATE TABLE "AccountType" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pricingHint" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountType_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountType_brokerId_idx" ON "AccountType"("brokerId");
CREATE UNIQUE INDEX "AccountType_brokerId_name_key" ON "AccountType"("brokerId", "name");

ALTER TABLE "AccountType" ADD CONSTRAINT "AccountType_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2b. accountTypeId FK on Account.
ALTER TABLE "Account" ADD COLUMN "accountTypeId" TEXT;
CREATE INDEX "Account_accountTypeId_idx" ON "Account"("accountTypeId");
ALTER TABLE "Account" ADD CONSTRAINT "Account_accountTypeId_fkey" FOREIGN KEY ("accountTypeId") REFERENCES "AccountType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2c. Seed Standard/Pro/Zero for every existing broker (Standard is the
-- default). id generated here (not app-supplied cuid) since this is a
-- one-time raw-SQL seed, not a Prisma Client write -- fine, the column
-- is untyped TEXT.
INSERT INTO "AccountType" ("id", "brokerId", "name", "description", "pricingHint", "sortOrder", "isDefault", "enabled", "updatedAt")
SELECT gen_random_uuid()::text, "Broker"."id", t.name, t.description, t."pricingHint", t."sortOrder", t."isDefault", true, now()
FROM "Broker"
CROSS JOIN (VALUES
  ('Standard', 'Balanced spread and commission -- suitable for most traders', 'Spread-only, no commission', 0, true),
  ('Pro', 'Tighter spreads with a per-lot commission', 'Raw spread + commission', 1, false),
  ('Zero', 'Near-zero spread, higher commission -- for high-volume traders', 'Near-zero spread + commission', 2, false)
) AS t(name, description, "pricingHint", "sortOrder", "isDefault");

-- 2d. Backfill every existing account to its own broker's isDefault
-- AccountType -- see Account.accountTypeId's own schema comment for why
-- this makes a real account effectively never null in practice despite
-- the column staying nullable.
UPDATE "Account"
SET "accountTypeId" = "AccountType"."id"
FROM "AccountType"
WHERE "AccountType"."brokerId" = "Account"."brokerId" AND "AccountType"."isDefault" = true;
