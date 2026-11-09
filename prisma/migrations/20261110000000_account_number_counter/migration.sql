-- Account numbers are never issued twice (owner 2026-11-10: 50005728 went to three accounts, each after the previous one
-- was deleted). One counter row holds the highest number ever issued; lib/account-provisioning.ts moves it forward.
-- Seeded from the highest number that exists now or was ever created (ACCOUNT_CREATED audit rows remember deleted
-- accounts). Additive: one new table, one row.
-- Revert: DROP TABLE "NumberCounter";
CREATE TABLE "NumberCounter" (
    "id" TEXT NOT NULL,
    "last" BIGINT NOT NULL,
    CONSTRAINT "NumberCounter_pkey" PRIMARY KEY ("id")
);
INSERT INTO "NumberCounter" ("id", "last")
SELECT 'account', GREATEST(
    50000999,
    COALESCE((SELECT MAX("accountNumber"::bigint) FROM "Account" WHERE "accountNumber" ~ '^[0-9]{1,15}$'), 0),
    COALESCE((SELECT MAX(("newValue"->>'accountNumber')::bigint) FROM "AuditLog"
              WHERE "action" = 'ACCOUNT_CREATED' AND ("newValue"->>'accountNumber') ~ '^[0-9]{1,15}$'), 0)
);
