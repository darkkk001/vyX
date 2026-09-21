-- Stage 2 prep, part 2: remove the leftover per-group SPREAD CONFIGS so pricing
-- runs on the source (BrokerSymbol) spread, and clear out two empty acmefx test
-- groups.
--
-- WHAT THIS DOES *NOT* TOUCH, deliberately and explicitly:
--   * No group on futurixglobal is deleted. Reverse Trading, Seawolf, B-Book,
--     Dealing, Demo and Dealer Coverage all stay exactly as they are.
--   * The reverse setup is a real, working configuration and stays whole:
--     the Reverse Trading group (category REVERSAL, 6 accounts), its enabled
--     MirrorRule (direction REVERSE), and the Reverse Master target account
--     50005702 (97 positions). Only the group's BTCUSD spread row is removed.
--   * No Account row is touched anywhere.
--   * No MirrorRule is touched.
--   * Broker.pricingEngineEnabled is not touched. Nothing is flipped here.
--
-- THIS IS A DELIBERATE PRICING CHANGE, not a no-op. After it, a NEW order in
-- one of these groups prices off BrokerSymbol (the source spread) instead of
-- the group override. The largest single effect: Reverse Trading BTCUSD stops
-- adding a 700 markup. Positions already open are unaffected -- they were
-- filled at their own price and are never re-priced.

-- ============================ 1. BEFORE ============================
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '--- GroupSymbolConfig BEFORE ---';
  FOR r IN
    SELECT b."subdomain" AS broker, g."name" AS grp, s."name" AS sym,
           c."spreadMarkup"::text AS spread, c."commissionPerLot"::text AS comm,
           (SELECT COUNT(*) FROM "Account" a WHERE a."groupId" = g.id) AS accts
      FROM "GroupSymbolConfig" c
      JOIN "Group" g  ON g.id = c."groupId"
      JOIN "Broker" b ON b.id = g."brokerId"
      JOIN "Symbol" s ON s.id = c."symbolId"
     ORDER BY b."subdomain", g."name", s."name"
  LOOP
    RAISE NOTICE '% / % / % : spread=% comm=% (accounts in group=%)',
      r.broker, r.grp, r.sym, r.spread, r.comm, r.accts;
  END LOOP;
END $$;

-- ================= 2. remove the leftover spread configs =================
-- Named one by one, matched on broker + group + symbol. No wildcard delete:
-- a blanket "DELETE FROM GroupSymbolConfig" would also take rows a broker
-- adds deliberately between now and this running.
--
-- acmefx / PlaywrightPricingTest is deliberately NOT in this list: its group
-- is held back in step 3 below, and its config goes with the group whenever
-- that is actually removed.
DELETE FROM "GroupSymbolConfig" c
 USING "Group" g, "Broker" b, "Symbol" s
 WHERE g.id = c."groupId" AND b.id = g."brokerId" AND s.id = c."symbolId"
   AND (
        -- the only non-zero markup in production; the group, its MirrorRule
        -- and the Reverse Master account all stay, only this row goes
        (b."subdomain" = 'futurixglobal' AND g."name" = 'Reverse Trading' AND s."name" = 'BTCUSD')
        -- the LP group's leftovers (0 accounts, never priced a fill)
     OR (b."subdomain" = 'futurixglobal' AND g."name" = 'Seawolf'         AND s."name" IN ('XAUUSD','XPTUSD','XRPUSD'))
        -- all-zero row, no effect either way, removed for tidiness
     OR (b."subdomain" = 'futurixglobal' AND g."name" = 'B-Book'          AND s."name" = 'BTCUSD')
        -- QA broker leftover
     OR (b."subdomain" = 'zzzqa'         AND g."name" = 'Standard-USD'    AND s."name" = 'EURUSD')
   );

-- ============ 3. delete the EMPTY acmefx test groups only ============
-- Account.groupId is ON DELETE SET NULL, so deleting a group that still holds
-- accounts would silently UNGROUP them rather than fail loudly. The NOT EXISTS
-- guard makes that impossible: a group that has gained an account since this
-- was written is skipped, not emptied.
--
-- PlaywrightPricingTest-1787917614906 is NOT listed. As of 2026-09-21 it holds
-- 3 DEMO accounts with 15 positions between them (one still OPEN), including
-- the seeded AcmeFX demo login 50001234. Deleting it would ungroup live demo
-- accounts, so it is left for an explicit decision.
DELETE FROM "Group" g
 USING "Broker" b
 WHERE b.id = g."brokerId"
   AND b."subdomain" = 'acmefx'
   AND g."name" IN ('RequestTraceTest', 'RobustNameTest')
   AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."groupId" = g.id)
   AND NOT EXISTS (SELECT 1 FROM "MirrorRule" m WHERE m."sourceType" = 'GROUP' AND m."sourceId" = g.id)
   AND g."isDefault" = false;

-- ============================ 4. AFTER ============================
DO $$
DECLARE r RECORD; left_cfg INT; left_grp INT; orphaned INT;
BEGIN
  RAISE NOTICE '--- GroupSymbolConfig AFTER ---';
  FOR r IN
    SELECT b."subdomain" AS broker, g."name" AS grp, s."name" AS sym,
           c."spreadMarkup"::text AS spread, c."commissionPerLot"::text AS comm
      FROM "GroupSymbolConfig" c
      JOIN "Group" g  ON g.id = c."groupId"
      JOIN "Broker" b ON b.id = g."brokerId"
      JOIN "Symbol" s ON s.id = c."symbolId"
     ORDER BY b."subdomain", g."name", s."name"
  LOOP
    RAISE NOTICE '% / % / % : spread=% comm=%', r.broker, r.grp, r.sym, r.spread, r.comm;
  END LOOP;

  SELECT COUNT(*) INTO left_cfg FROM "GroupSymbolConfig";
  RAISE NOTICE 'GroupSymbolConfig rows remaining: %', left_cfg;

  SELECT COUNT(*) INTO left_grp FROM "Group" g JOIN "Broker" b ON b.id = g."brokerId"
   WHERE b."subdomain" = 'acmefx' AND g."name" IN ('RequestTraceTest','RobustNameTest');
  RAISE NOTICE 'acmefx test groups remaining (expect 0): %', left_grp;

  -- nothing may have been ungrouped by this migration
  SELECT COUNT(*) INTO orphaned FROM "Account" WHERE "groupId" IS NULL;
  RAISE NOTICE 'ungrouped accounts now (was 18 before this migration): %', orphaned;

  RAISE NOTICE '--- reverse setup intact? ---';
  FOR r IN
    SELECT g."name" AS grp, g."category"::text AS cat,
           (SELECT COUNT(*) FROM "Account" a WHERE a."groupId" = g.id) AS accts,
           (SELECT COUNT(*) FROM "MirrorRule" m WHERE m."sourceType"='GROUP' AND m."sourceId" = g.id AND m.enabled) AS enabled_rules
      FROM "Group" g JOIN "Broker" b ON b.id = g."brokerId"
     WHERE b."subdomain" = 'futurixglobal' AND g."name" = 'Reverse Trading'
  LOOP
    RAISE NOTICE 'Reverse Trading: category=% accounts=% enabledMirrorRules=%', r.cat, r.accts, r.enabled_rules;
  END LOOP;
END $$;
