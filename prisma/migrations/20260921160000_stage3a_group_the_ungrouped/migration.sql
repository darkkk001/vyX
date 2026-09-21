-- Stage 3a: give every ungrouped account a group. DATA ONLY, reversible.
--
-- Today 18 accounts have Account.groupId = NULL, so they route by
-- BrokerSymbol.defaultBookType (per SYMBOL) instead of by their group. This
-- assigns each of them a real group. It does NOT make groupId NOT NULL and it
-- does NOT remove the defaultBookType fallback: that is Stage 3b, a later
-- release, once this is confirmed on production.
--
-- WHY NO FILL PRICE CAN MOVE. With the pricing engine now on, every account
-- resolves through resolvePricingV2. Measured on production immediately before
-- writing this: GroupSymbolConfig 0 rows, AccountTypeSymbolConfig 0 rows,
-- AccountSymbolConfig 0 rows, and 0 AccountTypes carrying any pricing. Every
-- level above BrokerSymbol is empty, so a grouped account and an ungrouped one
-- both fall through to BrokerSymbol. Adding a groupId inserts a level that has
-- nothing in it. (Step 5 re-asserts the emptiness rather than trusting it.)
--
-- WHAT ELSE IS DELIBERATELY HELD CONSTANT:
--   leverage      -- NOT copied from the group. Each account keeps its own, so
--                    futurix 50005686 stays at 1000 and no margin requirement
--                    moves. This is the one place this migration deviates from
--                    what PATCH /api/manage/accounts/[id] does on a manual
--                    reassignment, and it is deliberate.
--   margin levels -- an ungrouped account already defaults to
--                    marginCallLevel 100 / stopOutLevel 50
--                    (lib/risk-monitor.ts:240,166) and every target group is
--                    exactly 100/50, so stop-out behaviour is unchanged.
--   swap-free     -- resolved firstNonNull(account, accountType, group); the
--                    AccountType level outranks the group, so unchanged.
--   dealer queue  -- NOT solved by setting groups to AUTO. resolveWantsDealingQueue
--                    returns on `AUTO` BEFORE it reads either dealer switch, so an
--                    AUTO group can never be dealer-managed again: neither opens nor
--                    closes would ever queue, which would kill the
--                    CLOSES-respect-dealer-mode feature for that group
--                    (lib/queued-close.ts and positions/[id]/close both route through
--                    the same function). Instead step 3 turns the per-broker DESK
--                    switch to auto-fill and leaves every DEALING group on INHERIT,
--                    which is the state the dealing screen's own toggle drives.
--
-- REVERSIBILITY: every account's previous groupId (always NULL here) and its
-- leverage are printed as NOTICEs and written to AuditLog as
-- ACCOUNT_GROUP_CHANGED, so the assignment can be undone precisely.

-- ============ 0. resolve the intended moves, and refuse to guess ============
CREATE TEMP TABLE _stage3a (
  subdomain      text,
  account_number text,
  group_name     text,
  account_id     text,
  group_id       text,
  old_group_id   text,
  old_leverage   int
);

INSERT INTO _stage3a (subdomain, account_number, group_name) VALUES
  ('acmefx',        '50005681', 'Standard'),
  ('acmefx',        '50005682', 'Standard'),
  ('acmefx',        '50005683', 'Standard'),
  ('acmefx',        '50005684', 'Standard'),
  ('acmefx',        '50005685', 'Standard'),
  ('acmefx',        '50005688', 'Standard'),
  ('acmefx',        '50005689', 'Standard'),
  ('acmefx',        '50005691', 'Standard'),
  ('acmefx',        '50005692', 'Standard'),
  ('futurixglobal', '50005686', 'B-Book'),
  ('futurixglobal', '50005687', 'B-Book'),
  ('futurixglobal', '50005690', 'B-Book'),
  ('futurixglobal', '50005695', 'Demo'),
  -- The mirror rule's TARGET. Deliberately NOT "Reverse Trading": that group
  -- is the rule's SOURCE, so a target sitting inside it would have each
  -- mirrored fill land back in the source set and mirror again. B-Book also
  -- happens to be leverage 100, which is what this account already has.
  ('futurixglobal', '50005702', 'B-Book'),
  ('novamarkets',   '50005678', 'Standard'),   -- group created in step 2 below
  ('zzzqa',         '00090001', 'Standard-USD'),
  ('zzzqa',         '00090002', 'Standard-USD'),
  ('zzzqa',         '50005705', 'Standard-USD');

-- ==================== 2. novamarkets has no groups at all ====================
-- B_BOOK (the safe default: the broker holds the risk, no bridge), AUTO so
-- nothing queues for a dealer, and isDefault so a future account there cannot
-- land ungrouped again. groupType/tier are the shadow columns Stage 1 keeps.
INSERT INTO "Group" (
  id, "brokerId", "name", "category", "modeRestriction", "groupType", "dealingMode", "tier",
  "isDefault", "leverage", "marginCallLevel", "stopOutLevel", "createdAt", "updatedAt"
)
SELECT 'c' || replace(gen_random_uuid()::text, '-', ''), b.id, 'Standard',
       'B_BOOK'::"RoutingCategory", 'ANY'::"GroupModeRestriction",
       'DEALING'::"GroupType", 'AUTO'::"GroupDealingMode", 'STANDARD'::"GroupTier",
       true, 100, 100, 50, now(), now()
  FROM "Broker" b
 WHERE b."subdomain" = 'novamarkets'
   AND NOT EXISTS (SELECT 1 FROM "Group" g WHERE g."brokerId" = b.id);

-- ============ 3. dealer desk: auto-fill by default, dealer keeps control ============
-- The model: a DEALING-routing group stays on INHERIT so it is dealer
-- controllable, and the per-broker DESK switch decides the default state. The
-- dealing screen's own toggle writes exactly this field
-- (app/api/manage/dealing-desk-toggle/route.ts: `dealerOn` means
-- dealingDeskAutoFillAt IS NULL), so setting a timestamp here is the same
-- action as a dealer switching the desk to auto-fill, and they can switch it
-- back whenever they want to manage flow again.
--
-- Today every broker has this NULL, i.e. "dealer on", which is why INHERIT
-- groups queue while nobody is watching the queue. Turning it to auto-fill is
-- what makes today's default correct without disabling the feature:
--
--   INHERIT + desk auto-fill  -> auto-fills          (today, after this)
--   INHERIT + desk on         -> queues opens AND closes   (dealer's choice)
--   AUTO                      -> auto-fills, permanently, switch ignored
UPDATE "Broker" SET "dealingDeskAutoFillAt" = now()
 WHERE "subdomain" IN ('acmefx', 'futurixglobal', 'novamarkets', 'zzzqa')
   AND "dealingDeskAutoFillAt" IS NULL;

-- zzzqa had no default group at all, so a new account there would land
-- ungrouped again. dealingMode is deliberately left at INHERIT.
UPDATE "Group" g SET "isDefault" = true
  FROM "Broker" b
 WHERE b.id = g."brokerId" AND b."subdomain" = 'zzzqa' AND g."name" = 'Standard-USD';

-- Only one default per broker: zzzqa had none, but make that explicit rather
-- than assumed, in case one appears between now and this running.
UPDATE "Group" g SET "isDefault" = false
  FROM "Broker" b
 WHERE b.id = g."brokerId" AND b."subdomain" = 'zzzqa'
   AND g."name" <> 'Standard-USD' AND g."isDefault";

-- ==================== 4. resolve ids and validate ====================
UPDATE _stage3a s
   SET account_id   = a.id,
       old_group_id = a."groupId",
       old_leverage = a.leverage
  FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId"
 WHERE b."subdomain" = s.subdomain AND a."accountNumber" = s.account_number;

UPDATE _stage3a s
   SET group_id = g.id
  FROM "Group" g JOIN "Broker" b ON b.id = g."brokerId"
 WHERE b."subdomain" = s.subdomain AND g."name" = s.group_name;

DO $$
DECLARE missing_acct INT; missing_grp INT; already INT; bad_mode INT;
BEGIN
  SELECT COUNT(*) INTO missing_acct FROM _stage3a WHERE account_id IS NULL;
  IF missing_acct > 0 THEN
    RAISE EXCEPTION 'aborting: % listed account(s) do not exist on the named broker', missing_acct;
  END IF;

  SELECT COUNT(*) INTO missing_grp FROM _stage3a WHERE group_id IS NULL;
  IF missing_grp > 0 THEN
    RAISE EXCEPTION 'aborting: % target group(s) not found (novamarkets Standard should have been created in step 2)', missing_grp;
  END IF;

  -- Someone may have grouped one of these by hand since this was written.
  -- Do not silently move it somewhere else.
  SELECT COUNT(*) INTO already FROM _stage3a WHERE old_group_id IS NOT NULL;
  IF already > 0 THEN
    RAISE EXCEPTION 'aborting: % of the listed accounts already have a group; re-review the mapping', already;
  END IF;

  -- The same rule lib/account-structure.ts enforces on every write path: a
  -- DEMO account may not enter A_BOOK/COVERAGE or a LIVE_ONLY group, and a
  -- LIVE account may not enter a DEMO_ONLY one.
  SELECT COUNT(*) INTO bad_mode
    FROM _stage3a s JOIN "Account" a ON a.id = s.account_id JOIN "Group" g ON g.id = s.group_id
   WHERE (a."accountMode" = 'DEMO' AND (g."category" IN ('A_BOOK','COVERAGE') OR g."modeRestriction" = 'LIVE_ONLY'))
      OR (a."accountMode" = 'LIVE' AND g."modeRestriction" = 'DEMO_ONLY');
  IF bad_mode > 0 THEN
    RAISE EXCEPTION 'aborting: % assignment(s) would violate the mode/routing rules', bad_mode;
  END IF;
END $$;

-- ============================ 5. BEFORE ============================
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '--- BEFORE (old groupId is NULL for all of these; leverage is preserved) ---';
  FOR r IN
    SELECT s.subdomain, s.account_number, a."accountMode"::text AS mode, a.status::text,
           s.old_leverage, s.group_name, g."category"::text AS cat, g."dealingMode"::text AS dealing
      FROM _stage3a s JOIN "Account" a ON a.id = s.account_id JOIN "Group" g ON g.id = s.group_id
     ORDER BY s.subdomain, s.account_number
  LOOP
    RAISE NOTICE '% / % (% %) leverage=% -> group "%" [% / dealing=%]',
      r.subdomain, r.account_number, r.mode, r.status, r.old_leverage, r.group_name, r.cat, r.dealing;
  END LOOP;
END $$;

-- ==================== 6. the assignment + audit trail ====================
-- leverage is deliberately absent from this UPDATE.
UPDATE "Account" a
   SET "groupId" = s.group_id, "updatedAt" = now()
  FROM _stage3a s
 WHERE a.id = s.account_id;

INSERT INTO "AuditLog" (id, "brokerId", "actorAdminId", action, "entityType", "entityId", "oldValue", "newValue", "createdAt")
SELECT 'c' || replace(gen_random_uuid()::text, '-', ''),
       a."brokerId", NULL, 'ACCOUNT_GROUP_CHANGED', 'Account', a.id,
       jsonb_build_object('groupId', s.old_group_id, 'leverage', s.old_leverage,
                          'note', 'Stage 3a: account was ungrouped and routed by BrokerSymbol.defaultBookType'),
       jsonb_build_object('groupId', s.group_id, 'groupName', s.group_name, 'leverage', s.old_leverage,
                          'note', 'Stage 3a: grouped; leverage deliberately preserved, not copied from the group'),
       now()
  FROM _stage3a s JOIN "Account" a ON a.id = s.account_id;

-- ============================ 7. AFTER ============================
DO $$
DECLARE n INT; lev_changed INT; gsc INT; r RECORD;
BEGIN
  RAISE NOTICE '--- AFTER ---';

  SELECT COUNT(*) INTO n FROM "Account" WHERE "groupId" IS NULL;
  RAISE NOTICE 'ungrouped accounts remaining (expect 0): %', n;

  SELECT COUNT(*) INTO lev_changed
    FROM _stage3a s JOIN "Account" a ON a.id = s.account_id
   WHERE a.leverage IS DISTINCT FROM s.old_leverage;
  RAISE NOTICE 'accounts whose leverage changed (expect 0): %', lev_changed;

  -- The premise the "no price can move" claim rests on.
  SELECT COUNT(*) INTO gsc FROM "GroupSymbolConfig";
  RAISE NOTICE 'GroupSymbolConfig rows (expect 0, or fills could differ by group): %', gsc;
  IF gsc > 0 THEN
    RAISE EXCEPTION 'aborting: a GroupSymbolConfig row exists, so grouping these accounts could change their fills. Re-run the shadow comparison and re-review.';
  END IF;

  -- The principle this migration encodes: DEALING routing stays INHERIT so a
  -- dealer can manage it; every other category is AUTO because it is never dealt.
  -- Informational, not a gate: named so a deviation is reviewable rather than
  -- a bare count. Deviations with 0 accounts affect nothing today.
  FOR r IN
    SELECT b."subdomain" AS broker, g."name", g."category"::text AS cat,
           g."dealingMode"::text AS dealing,
           (SELECT COUNT(*) FROM "Account" a WHERE a."groupId" = g.id) AS accts
      FROM "Group" g JOIN "Broker" b ON b.id = g."brokerId"
     WHERE (g."category" = 'DEALING' AND g."dealingMode" <> 'INHERIT')
        OR (g."category" IN ('B_BOOK','A_BOOK','REVERSAL') AND g."dealingMode" <> 'AUTO')
     ORDER BY b."subdomain", g."name"
  LOOP
    RAISE NOTICE 'deviates from DEALING=INHERIT / other=AUTO: % / % [%] dealing=% accounts=%',
      r.broker, r.name, r.cat, r.dealing, r.accts;
  END LOOP;

  SELECT COUNT(*) INTO n FROM "Broker" WHERE "dealingDeskAutoFillAt" IS NULL;
  RAISE NOTICE 'brokers whose desk is still ON (expect 0 right after this): %', n;

  RAISE NOTICE '--- group membership now ---';
  FOR r IN
    SELECT b."subdomain" AS broker, g."name", g."category"::text AS cat,
           g."dealingMode"::text AS dealing, g."isDefault",
           (SELECT COUNT(*) FROM "Account" a WHERE a."groupId" = g.id) AS accts
      FROM "Group" g JOIN "Broker" b ON b.id = g."brokerId"
     ORDER BY b."subdomain", g."name"
  LOOP
    RAISE NOTICE '% / % [%] dealing=% default=% accounts=%',
      r.broker, r.name, r.cat, r.dealing, r."isDefault", r.accts;
  END LOOP;
END $$;

DROP TABLE _stage3a;
