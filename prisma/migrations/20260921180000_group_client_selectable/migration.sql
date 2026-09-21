-- Stage 4 piece 6: Group.isClientSelectable -- may a CLIENT pick this group?
--
-- WHY A COLUMN AND NOT AN INFERENCE FROM category:
-- The first cut of app/api/portal/groups derived client-eligibility from the
-- routing category (B_BOOK and DEALING yes, A_BOOK/REVERSAL/COVERAGE no). That
-- is wrong in both directions. A broker may legitimately run two B_BOOK groups
-- and publicly offer only one (the other being an internal or staff book), and
-- no COVERAGE or REVERSAL group may EVER be offered regardless of how it is
-- routed. Routing answers "where does the risk go" and is broker-side;
-- selectability is a product decision. They are different questions.
--
-- SAFE BY CONSTRUCTION: the column defaults to FALSE, so the failure mode of
-- forgetting to set it is a group no client can see -- never a client landing
-- in the broker's own hedge book or the reverse-mirror source group.
--
-- NOT A BEHAVIOUR CHANGE: nothing reads this column until the web deploy that
-- accompanies it. The backfill below reproduces exactly what the existing
-- category filter already allowed, so the first read returns the same set the
-- inference did.

-- ==================== 1. the column ====================
ALTER TABLE "Group" ADD COLUMN "isClientSelectable" BOOLEAN NOT NULL DEFAULT false;

-- ==================== 2. backfill ====================
-- A_BOOK is included on purpose: it is a CLIENT book, just one whose risk is
-- bridged to a liquidity provider instead of held. The two excluded categories
-- are the ones that are not about clients at all -- COVERAGE is the broker's
-- own hedge account and REVERSAL is the reverse-mirror source book.
--
-- Deliberately keyed on category ONLY, not on tradingHaltedAt. A halt is a
-- temporary runtime state that the portal query filters on separately; baking
-- it into a config column would leave a group permanently unselectable after
-- the broker un-halts it, which is a bug that would surface weeks later.
UPDATE "Group"
   SET "isClientSelectable" = true
 WHERE "category" IN ('A_BOOK', 'B_BOOK', 'DEALING');

-- ==================== 3. before/after ====================
DO $$
DECLARE r RECORD; n_sel INT; n_hidden INT;
BEGIN
  RAISE NOTICE '--- client-selectable groups after backfill ---';
  FOR r IN
    SELECT b."subdomain" AS broker, g."name" AS grp, g."category"::text AS cat,
           g."modeRestriction"::text AS mode, g."isClientSelectable" AS sel,
           (g."tradingHaltedAt" IS NOT NULL) AS halted,
           (SELECT COUNT(*) FROM "Account" a WHERE a."groupId" = g.id) AS accts
      FROM "Group" g JOIN "Broker" b ON b.id = g."brokerId"
     ORDER BY b."subdomain", g."isClientSelectable" DESC, g."name"
  LOOP
    RAISE NOTICE '  % / % : category=% mode=% selectable=% halted=% accounts=%',
      r.broker, r.grp, r.cat, r.mode, r.sel, r.halted, r.accts;
  END LOOP;

  SELECT COUNT(*) INTO n_sel    FROM "Group" WHERE "isClientSelectable";
  SELECT COUNT(*) INTO n_hidden FROM "Group" WHERE NOT "isClientSelectable";
  RAISE NOTICE 'selectable=% hidden=%', n_sel, n_hidden;

  -- The whole point of the column. If any of these three ever became
  -- selectable, a client could open an account in the broker's own hedge book
  -- or the reverse-mirror source group.
  PERFORM 1 FROM "Group"
   WHERE "isClientSelectable" AND "category" IN ('COVERAGE', 'REVERSAL');
  IF FOUND THEN
    RAISE EXCEPTION 'aborting: a COVERAGE or REVERSAL group was marked client-selectable';
  END IF;
  RAISE NOTICE 'verified: no COVERAGE or REVERSAL group is client-selectable';
END $$;
