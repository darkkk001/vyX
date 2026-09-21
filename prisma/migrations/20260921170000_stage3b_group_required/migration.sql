-- Stage 3b: every account must have a group.
--
-- Stage 3a gave the last 18 ungrouped accounts a group. This makes that
-- permanent at the schema level, so the per-symbol fallback
-- (BrokerSymbol.defaultBookType) can be deleted from the routing code: with
-- groupId NOT NULL there is no longer an account for it to serve.
--
-- The COLUMN BrokerSymbol.defaultBookType is deliberately KEPT for one
-- release. Nothing reads it after the web deploy that accompanies this, but
-- keeping it means rolling that deploy back restores the old readers with no
-- data loss. Stage 5 drops it.
--
-- DEPLOY ORDER MATTERS, in this direction only:
--   1. this migration   -- old code still runs; its fallback simply becomes
--                          unreachable, because no account has a null group
--   2. then the web deploy that removes the fallback
-- The reverse order would put code that dereferences account.group in front
-- of a database that still permits NULL, which is a crash rather than a
-- fallback. Between step 1 and step 2 production is fully functional.

-- ==================== 1. precondition, not an assumption ====================
DO $$
DECLARE ungrouped INT; r RECORD; brokers_without_default INT;
BEGIN
  SELECT COUNT(*) INTO ungrouped FROM "Account" WHERE "groupId" IS NULL;
  RAISE NOTICE 'ungrouped accounts before: %', ungrouped;
  IF ungrouped > 0 THEN
    FOR r IN
      SELECT b."subdomain", a."accountNumber"
        FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId"
       WHERE a."groupId" IS NULL ORDER BY 1, 2
    LOOP
      RAISE NOTICE '  still ungrouped: % / %', r."subdomain", r."accountNumber";
    END LOOP;
    RAISE EXCEPTION 'aborting: % account(s) still have no group. Run Stage 3a first.', ungrouped;
  END IF;

  -- With groupId NOT NULL, a broker that has no default group can no longer
  -- have an account created for it at all: provisionAccount would pass NULL
  -- and hit a constraint violation. Every broker has one today; warn loudly
  -- if that ever stops being true, because the failure would surface as a
  -- broken signup rather than anything obviously related to this migration.
  SELECT COUNT(*) INTO brokers_without_default
    FROM "Broker" b
   WHERE NOT EXISTS (SELECT 1 FROM "Group" g WHERE g."brokerId" = b.id AND g."isDefault");
  IF brokers_without_default > 0 THEN
    RAISE WARNING 'STAGE4-PIECE-6: % broker(s) have no default group. Account creation for them will now fail until one exists.', brokers_without_default;
  ELSE
    RAISE NOTICE 'every broker has a default group: account creation is safe';
  END IF;
END $$;

-- ==================== 2. the constraint ====================
ALTER TABLE "Account" ALTER COLUMN "groupId" SET NOT NULL;

-- ==================== 3. after ====================
DO $$
DECLARE nullable TEXT;
BEGIN
  SELECT is_nullable INTO nullable FROM information_schema.columns
   WHERE table_name = 'Account' AND column_name = 'groupId';
  RAISE NOTICE 'Account.groupId is_nullable now: % (expect NO)', nullable;
  RAISE NOTICE 'BrokerSymbol.defaultBookType is intentionally still present; Stage 5 drops it.';
END $$;
