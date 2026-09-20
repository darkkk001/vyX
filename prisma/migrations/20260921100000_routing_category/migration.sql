-- Stage 1 of docs/ACCOUNT-STRUCTURE-MIGRATION.md: give a Group the ROUTING
-- axis (where the order goes and who holds the risk) as its own column,
-- separate from MODE (real vs practice money, Account.accountMode, which
-- already exists and is NOT touched here).
--
-- Three independent concepts, per the confirmed model (§0.1):
--   MODE          Account.accountMode      client-facing, LIVE | DEMO
--   ACCOUNT TYPE  AccountType              client-facing, the tier the client
--                                          picks (Standard/Pro/Zero), each with
--                                          its own spread. UNTOUCHED by this
--                                          migration -- it is not bound to
--                                          routing, because a "Pro" client must
--                                          not be able to infer how the broker
--                                          books them.
--   ROUTING       Group.category           broker-side and invisible to the
--                                          client. New here.
--
-- Additive and reversible: Group.groupType and Group.tier stay exactly as
-- they are, still populated, read by nothing after this release's code
-- lands. Rolling the web build back restores the old readers with zero
-- data loss. Stage 5 drops them.
--
-- The plan called for a separate hand-reviewed overrides.sql in this
-- directory; Prisma only executes migration.sql, so the override lives
-- inline in step 4 below under its own banner instead of in a second file
-- that would have to be kept in sync by hand.

-- ---------------------------------------------------------------- 1. enums
CREATE TYPE "RoutingCategory" AS ENUM ('A_BOOK', 'B_BOOK', 'DEALING', 'REVERSAL', 'COVERAGE');
CREATE TYPE "GroupModeRestriction" AS ENUM ('ANY', 'LIVE_ONLY', 'DEMO_ONLY');

-- ------------------------------------------------- 2. columns, nullable first
-- Nullable with no default on purpose: ADD COLUMN ... DEFAULT would stamp
-- every existing row with the default BEFORE the backfill below could give
-- it its real value, and the backfill would then be unable to tell "never
-- set" from "deliberately B_BOOK". Default and NOT NULL go on in step 6.
ALTER TABLE "Group" ADD COLUMN "category" "RoutingCategory";
ALTER TABLE "Group" ADD COLUMN "modeRestriction" "GroupModeRestriction";

-- ------------------------------------------------------- 3. backfill groups
-- Rules of §1.2, first match wins. The mirror-source test is only reached
-- for groupType='DEALING' because COVERAGE/LP/DEMO are handled above it,
-- which is exactly the rule order the plan specifies.
--
-- NOT a rule any more (deleted from the first draft): "every account in
-- this group is accountMode='DEMO' -> DEMO". That read the MODE of the
-- members to guess the group's ROUTING. With the axes separated there is
-- nothing to infer -- a group full of demo accounts keeps its routing and
-- only gets DEMO_ONLY if a human says so (step 4).
UPDATE "Group" g SET
  "category" = CASE
    WHEN g."groupType" = 'COVERAGE' THEN 'COVERAGE'::"RoutingCategory"
    WHEN g."groupType" = 'LP'       THEN 'A_BOOK'::"RoutingCategory"
    WHEN g."groupType" = 'DEMO'     THEN 'B_BOOK'::"RoutingCategory"
    WHEN EXISTS (
      SELECT 1 FROM "MirrorRule" m
       WHERE m."sourceType" = 'GROUP' AND m."sourceId" = g.id
    )                               THEN 'REVERSAL'::"RoutingCategory"
    WHEN g."dealingMode" = 'AUTO'   THEN 'B_BOOK'::"RoutingCategory"
    ELSE                                 'DEALING'::"RoutingCategory"
  END,
  "modeRestriction" = CASE
    -- Practice money is never bridged to a real LP, and the coverage
    -- account is the broker's own. lib/account-structure.ts enforces this
    -- for A_BOOK/COVERAGE regardless of the column; writing it here too
    -- just makes the data say what the code already guarantees.
    WHEN g."groupType" IN ('COVERAGE', 'LP') THEN 'LIVE_ONLY'::"GroupModeRestriction"
    WHEN g."groupType" = 'DEMO'              THEN 'DEMO_ONLY'::"GroupModeRestriction"
    ELSE                                          'ANY'::"GroupModeRestriction"
  END;

-- ============================ 4. OVERRIDES (hand-reviewed, §1.2) ============================
-- For groups whose NAME says what the data does not. Reviewed against the
-- 2026-09-18 prod read; anything added here must be reviewed the same way
-- and must name the broker, never match on name alone.
--
-- futurixglobal / "Demo": rule 5 above gets the ROUTING right (it is a
-- DEALING/AUTO group, so B_BOOK) but not the restriction. "Demo" is a
-- statement about mode, so it becomes DEMO_ONLY. 0 accounts today.
UPDATE "Group" g
   SET "category" = 'B_BOOK'::"RoutingCategory",
       "modeRestriction" = 'DEMO_ONLY'::"GroupModeRestriction"
  FROM "Broker" b
 WHERE b.id = g."brokerId"
   AND b."subdomain" = 'futurixglobal'
   AND g."name" = 'Demo';
-- ========================== END OVERRIDES ==========================

-- --------------------------------------------- 5. print the group mapping
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '--- group routing/mode mapping ---';
  FOR r IN
    SELECT b."subdomain" AS broker, g."name",
           g."groupType"::text AS old_type, g."dealingMode"::text AS dealing_mode,
           EXISTS (SELECT 1 FROM "MirrorRule" m WHERE m."sourceType" = 'GROUP' AND m."sourceId" = g.id) AS has_mirror,
           (SELECT COUNT(*) FROM "Account" a WHERE a."groupId" = g.id) AS accounts,
           (SELECT COUNT(*) FROM "Account" a WHERE a."groupId" = g.id AND a."accountMode" = 'DEMO') AS demo_accounts,
           g."category"::text AS category, g."modeRestriction"::text AS mode_restriction
      FROM "Group" g JOIN "Broker" b ON b.id = g."brokerId"
     ORDER BY b."subdomain", g."name"
  LOOP
    RAISE NOTICE '% / % : groupType=% dealingMode=% mirror=% accounts=% (demo=%) -> % / %',
      r.broker, r.name, r.old_type, r.dealing_mode, r.has_mirror, r.accounts, r.demo_accounts,
      r.category, r.mode_restriction;
  END LOOP;
END $$;

-- ------------------------------------------- 6. defaults, then NOT NULL
-- B_BOOK is the default for any NEW group, live or demo: the safe one. The
-- order stays with the broker, there is no bridge and no external
-- dependency until the broker explicitly configures one (which is what the
-- Liquidity tab is for, and only A_BOOK groups appear there).
ALTER TABLE "Group" ALTER COLUMN "category"        SET DEFAULT 'B_BOOK';
ALTER TABLE "Group" ALTER COLUMN "modeRestriction" SET DEFAULT 'ANY';

ALTER TABLE "Group" ALTER COLUMN "category"        SET NOT NULL;
ALTER TABLE "Group" ALTER COLUMN "modeRestriction" SET NOT NULL;

CREATE INDEX "Group_brokerId_category_idx" ON "Group" ("brokerId", "category");

-- AccountType is deliberately absent from this migration. It is the
-- client-facing tier (Standard/Pro/Zero, each with its own spread) and
-- carries no routing: any type may be used by any group, so a client
-- picking "Pro" learns nothing about whether the broker A-books, B-books
-- or deals them. Its @@unique([brokerId, name]) and its single
-- default-per-broker rule are unchanged.
