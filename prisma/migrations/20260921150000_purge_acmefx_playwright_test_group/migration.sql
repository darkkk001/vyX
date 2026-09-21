-- Stage 2 prep, part 3: purge the acmefx PlaywrightPricingTest group, its three
-- DEMO accounts and every row that hangs off them.
--
-- SCOPE: acmefx only. Nothing on futurixglobal is read or written by this
-- migration. The reverse setup (Reverse Trading group, its enabled MirrorRule,
-- Reverse Master account 50005702), Seawolf, B-Book, Dealing, Demo and Dealer
-- Coverage are all untouched, as are every futurix account and position.
--
-- WHAT IS BEING DELETED (verified against production 2026-09-21):
--   group   acmefx / PlaywrightPricingTest-1787917614906
--   accounts 50001234 (Demo Trader, balance -1,888,679.12, 14 positions)
--            50005693 (Playwright GroupTypes Test, 0 positions)
--            50005694 (Playwright GroupTypes Test, 1 OPEN position)
--   all three are accountMode=DEMO on acmefx. 50001234 is the seeded AcmeFX
--   demo login from prisma/seed.ts, not a real client.
--
-- CRITICAL-REFERENCE CHECK, run read-only before writing this file -- all clear:
--   MirrorRule targeting or sourcing them ......... 0
--   Broker.coverageAccountId pointing at them ..... 0
--   Portal Client linked (Account.clientId) ....... 0
--   LiveAccountRequest.createdAccountId ........... 0
--   PositionActionRequest on their positions ...... 0
--   Position.coveragePositionId (hedged legs) ..... 0
--   Order.closesPositionId from another account ... 0
--   KycRecord / IbRelationship / BalanceAdjustmentRequest / LoginEvent / Lead / Notification ... 0
-- Rows that DO exist and are removed here: 15 Position, 20 Order,
-- 22 Transaction, 10 WatchlistItem, 10 AuditLog (entityId, not an FK).
--
-- ORDER MATTERS: Position.originOrderId -> Order is ON DELETE RESTRICT, so the
-- positions must go before the orders. Everything else pointing at Account is
-- RESTRICT too, hence the explicit sequence rather than relying on cascades.

-- ===================== 0. resolve the targets, safely =====================
-- Matched on broker subdomain AND accountMode as well as the numbers, so this
-- can never reach a futurix account or a LIVE one even if an account number
-- were reused. If the set does not look exactly as expected, abort the whole
-- migration rather than delete something unintended.
CREATE TEMP TABLE _purge_accounts AS
  SELECT a.id
    FROM "Account" a
    JOIN "Broker" b ON b.id = a."brokerId"
   WHERE b."subdomain" = 'acmefx'
     AND a."accountMode" = 'DEMO'
     AND a."accountNumber" IN ('50001234', '50005693', '50005694');

CREATE TEMP TABLE _purge_group AS
  SELECT g.id
    FROM "Group" g
    JOIN "Broker" b ON b.id = g."brokerId"
   WHERE b."subdomain" = 'acmefx'
     AND g."name" = 'PlaywrightPricingTest-1787917614906';

DO $$
DECLARE n_acc INT; n_grp INT; n_bad INT;
BEGIN
  SELECT COUNT(*) INTO n_acc FROM _purge_accounts;
  SELECT COUNT(*) INTO n_grp FROM _purge_group;
  RAISE NOTICE 'resolved % acmefx DEMO accounts and % group', n_acc, n_grp;

  -- refuse to run if a critical reference appeared since this was written
  SELECT COUNT(*) INTO n_bad FROM "MirrorRule" m
   WHERE m."targetAccountId" IN (SELECT id FROM _purge_accounts)
      OR m."sourceId"        IN (SELECT id FROM _purge_accounts);
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'aborting: % MirrorRule row(s) now reference these accounts', n_bad;
  END IF;

  SELECT COUNT(*) INTO n_bad FROM "Broker" WHERE "coverageAccountId" IN (SELECT id FROM _purge_accounts);
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'aborting: a broker coverage account now points at one of these accounts';
  END IF;

  SELECT COUNT(*) INTO n_bad FROM "Account"
   WHERE id IN (SELECT id FROM _purge_accounts) AND "clientId" IS NOT NULL;
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'aborting: % of these accounts now belong to a portal Client', n_bad;
  END IF;
END $$;

-- ============================ 1. BEFORE ============================
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '--- BEFORE ---';
  FOR r IN
    SELECT a."accountNumber", a."accountMode"::text AS mode, a.status::text, a.balance::text AS bal,
           (SELECT COUNT(*) FROM "Position"      x WHERE x."accountId" = a.id) AS positions,
           (SELECT COUNT(*) FROM "Position"      x WHERE x."accountId" = a.id AND x.status='OPEN') AS open_pos,
           (SELECT COUNT(*) FROM "Order"         x WHERE x."accountId" = a.id) AS orders,
           (SELECT COUNT(*) FROM "Transaction"   x WHERE x."accountId" = a.id) AS txns,
           (SELECT COUNT(*) FROM "WatchlistItem" x WHERE x."accountId" = a.id) AS watchlist
      FROM "Account" a WHERE a.id IN (SELECT id FROM _purge_accounts)
     ORDER BY a."accountNumber"
  LOOP
    RAISE NOTICE 'acct % (%) status=% balance=% positions=% (open=%) orders=% txns=% watchlist=%',
      r."accountNumber", r.mode, r.status, r.bal, r.positions, r.open_pos, r.orders, r.txns, r.watchlist;
  END LOOP;
END $$;

-- ===================== 2. delete the dependants =====================
-- Position BEFORE Order (Position.originOrderId is RESTRICT).
UPDATE "Position" SET "closePendingOrderId" = NULL
 WHERE "accountId" IN (SELECT id FROM _purge_accounts);
UPDATE "Order" SET "closesPositionId" = NULL
 WHERE "accountId" IN (SELECT id FROM _purge_accounts);

DELETE FROM "PositionActionRequest" WHERE "positionId" IN
  (SELECT id FROM "Position" WHERE "accountId" IN (SELECT id FROM _purge_accounts));
DELETE FROM "Position"              WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "Order"                 WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "Transaction"           WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "WatchlistItem"         WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "LoginEvent"            WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "AccountSymbolConfig"   WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "Notification"          WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "KycRecord"             WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "BalanceAdjustmentRequest" WHERE "accountId" IN (SELECT id FROM _purge_accounts);
DELETE FROM "IbRelationship"        WHERE "clientAccountId" IN (SELECT id FROM _purge_accounts)
                                       OR "ibAccountId"     IN (SELECT id FROM _purge_accounts);
UPDATE "Lead"               SET "convertedAccountId" = NULL WHERE "convertedAccountId" IN (SELECT id FROM _purge_accounts);
UPDATE "LiveAccountRequest" SET "createdAccountId"   = NULL WHERE "createdAccountId"   IN (SELECT id FROM _purge_accounts);

-- AuditLog.entityId is a polymorphic reference, not a foreign key, so these
-- rows would not block the delete -- they would just point at an account that
-- no longer exists. Removed so nothing dangles.
DELETE FROM "AuditLog" WHERE "entityId" IN (SELECT id FROM _purge_accounts);

-- ================ 3. the accounts, then the empty group ================
DELETE FROM "Account" WHERE id IN (SELECT id FROM _purge_accounts);

-- GroupSymbolConfig and GroupSymbol are ON DELETE CASCADE from Group, so the
-- group's EURUSD 5/2 override goes with it. The NOT EXISTS guard keeps the
-- "never silently ungroup an account" rule from the previous migration.
DELETE FROM "Group" g
 WHERE g.id IN (SELECT id FROM _purge_group)
   AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."groupId" = g.id)
   AND NOT EXISTS (SELECT 1 FROM "MirrorRule" m WHERE m."sourceType" = 'GROUP' AND m."sourceId" = g.id)
   AND g."isDefault" = false;

-- ============================ 4. AFTER ============================
DO $$
DECLARE n INT; fx_groups INT; fx_accounts INT; fx_rule INT; gsc INT;
BEGIN
  RAISE NOTICE '--- AFTER ---';

  SELECT COUNT(*) INTO n FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId"
   WHERE b."subdomain"='acmefx' AND a."accountNumber" IN ('50001234','50005693','50005694');
  RAISE NOTICE 'the three test accounts remaining (expect 0): %', n;

  SELECT COUNT(*) INTO n FROM "Group" g JOIN "Broker" b ON b.id = g."brokerId"
   WHERE b."subdomain"='acmefx' AND g."name"='PlaywrightPricingTest-1787917614906';
  RAISE NOTICE 'PlaywrightPricingTest group remaining (expect 0): %', n;

  SELECT COUNT(*) INTO gsc FROM "GroupSymbolConfig";
  RAISE NOTICE 'GroupSymbolConfig rows remaining platform-wide (expect 0): %', gsc;

  -- nothing may dangle
  SELECT COUNT(*) INTO n FROM "Position" p LEFT JOIN "Account" a ON a.id = p."accountId" WHERE a.id IS NULL;
  RAISE NOTICE 'positions with no account (expect 0): %', n;
  SELECT COUNT(*) INTO n FROM "Order" o LEFT JOIN "Account" a ON a.id = o."accountId" WHERE a.id IS NULL;
  RAISE NOTICE 'orders with no account (expect 0): %', n;
  SELECT COUNT(*) INTO n FROM "Transaction" t LEFT JOIN "Account" a ON a.id = t."accountId" WHERE a.id IS NULL;
  RAISE NOTICE 'transactions with no account (expect 0): %', n;

  -- futurix must be exactly as it was
  SELECT COUNT(*) INTO fx_groups   FROM "Group" g   JOIN "Broker" b ON b.id=g."brokerId" WHERE b."subdomain"='futurixglobal';
  SELECT COUNT(*) INTO fx_accounts FROM "Account" a JOIN "Broker" b ON b.id=a."brokerId" WHERE b."subdomain"='futurixglobal';
  SELECT COUNT(*) INTO fx_rule     FROM "MirrorRule" m JOIN "Broker" b ON b.id=m."brokerId"
   WHERE b."subdomain"='futurixglobal' AND m.enabled;
  RAISE NOTICE 'futurix untouched: groups=% (expect 6) accounts=% (expect 16) enabledMirrorRules=% (expect 1)',
    fx_groups, fx_accounts, fx_rule;
END $$;

DROP TABLE _purge_accounts;
DROP TABLE _purge_group;
