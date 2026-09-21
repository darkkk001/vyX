-- Stage 2 prerequisite: make AccountType pricing mean "inherit" again, so the
-- pricing engine can be switched on without changing a single live fill.
--
-- THE PROBLEM
-- lib/pricing-engine.ts::resolvePricingV2 decides whether a level is "set" by
-- testing for NOT NULL, not for non-zero:
--
--     (params.accountType?.spreadMarkup !== null && ... !== undefined
--        ? { mode: "markup", spreadMarkup: params.accountType.spreadMarkup }
--        : null) ?? resolveSpreadAtSymbolLevel(params.groupSymbolConfig) ?? ...
--
-- The 2026-09-07 migration pricing_engine_nullable_widening made these columns
-- nullable but left every existing row holding a literal 0. So the AccountType
-- level counts as deliberately set to zero and WINS, and GroupSymbolConfig --
-- the only layer that carries real pricing in this system -- is never reached.
-- AccountType.spreadMarkup's own schema comment already flagged this exact
-- ambiguity: "a broker who already saved a deliberate 0 here looks identical to
-- one who never touched it."
--
-- Measured against production on 2026-09-21 with
-- `scripts/pricing-shadow-compare.ts`, flipping Broker.pricingEngineEnabled
-- as the data stands today would have changed real fills:
--   futurixglobal   6 diff rows   all 6 Reverse Trading accounts, BTCUSD
--                                 spreadMarkup 700 -> 0 (the only non-zero
--                                 markup actually in use on the platform)
--   acmefx        117 diff rows   swapLong -1.2 -> 0, swapShort 0.35 -> 0 on
--                                 every symbol; plus EURUSD spread 5 -> 0 and
--                                 commission 2 -> 0 for one group
--   novamarkets     9 diff rows   swaps -1.2 -> 0, 0.35 -> 0
--   zzzqa           0 diff rows
--
-- THE FIX
-- Set those four columns back to NULL, which is what "inherit" means in this
-- chain, so resolution falls through to GroupSymbolConfig and lands on exactly
-- the values in force today. This matches the model the platform actually runs
-- on (docs/CURRENT-STRUCTURE-MAP.md §3): the GROUP is the tier, and AccountType
-- is the client-facing label. A broker who genuinely wants a zero-spread tier
-- can set 0 deliberately once the engine is on, where it will mean something.
--
-- Per field and only where the value is currently 0, so that a non-zero value
-- someone set on purpose between now and this migration running is preserved
-- rather than silently erased. Idempotent. Broker.pricingEngineEnabled is NOT
-- touched here -- this migration only removes the obstacle to flipping it.
--
-- swapFree is deliberately left alone: it is a real tri-state (futurixglobal's
-- types carry true on purpose) and the shadow comparison reports no diffs on it.

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '--- AccountType pricing BEFORE ---';
  FOR r IN
    SELECT b."subdomain" AS broker, t."name",
           t."spreadMarkup"::text AS spread, t."commissionPerLot"::text AS comm,
           t."swapLong"::text AS swap_long, t."swapShort"::text AS swap_short,
           (SELECT COUNT(*) FROM "Account" a WHERE a."accountTypeId" = t.id) AS accounts
      FROM "AccountType" t JOIN "Broker" b ON b.id = t."brokerId"
     ORDER BY b."subdomain", t."sortOrder", t."name"
  LOOP
    RAISE NOTICE '% / % : spread=% comm=% swapL=% swapS=% (accounts=%)',
      r.broker, r.name, COALESCE(r.spread,'NULL'), COALESCE(r.comm,'NULL'),
      COALESCE(r.swap_long,'NULL'), COALESCE(r.swap_short,'NULL'), r.accounts;
  END LOOP;
END $$;

UPDATE "AccountType" SET
  "spreadMarkup"     = CASE WHEN "spreadMarkup"     = 0 THEN NULL ELSE "spreadMarkup"     END,
  "commissionPerLot" = CASE WHEN "commissionPerLot" = 0 THEN NULL ELSE "commissionPerLot" END,
  "swapLong"         = CASE WHEN "swapLong"         = 0 THEN NULL ELSE "swapLong"         END,
  "swapShort"        = CASE WHEN "swapShort"        = 0 THEN NULL ELSE "swapShort"        END
WHERE "spreadMarkup" = 0 OR "commissionPerLot" = 0 OR "swapLong" = 0 OR "swapShort" = 0;

DO $$
DECLARE r RECORD; remaining INT;
BEGIN
  RAISE NOTICE '--- AccountType pricing AFTER ---';
  FOR r IN
    SELECT b."subdomain" AS broker, t."name",
           t."spreadMarkup"::text AS spread, t."commissionPerLot"::text AS comm,
           t."swapLong"::text AS swap_long, t."swapShort"::text AS swap_short
      FROM "AccountType" t JOIN "Broker" b ON b.id = t."brokerId"
     ORDER BY b."subdomain", t."sortOrder", t."name"
  LOOP
    RAISE NOTICE '% / % : spread=% comm=% swapL=% swapS=%',
      r.broker, r.name, COALESCE(r.spread,'NULL'), COALESCE(r.comm,'NULL'),
      COALESCE(r.swap_long,'NULL'), COALESCE(r.swap_short,'NULL');
  END LOOP;

  SELECT COUNT(*) INTO remaining FROM "AccountType"
   WHERE "spreadMarkup" IS NOT NULL OR "commissionPerLot" IS NOT NULL
      OR "swapLong" IS NOT NULL OR "swapShort" IS NOT NULL;
  RAISE NOTICE 'AccountType rows still carrying an explicit (non-zero) pricing value: %', remaining;
END $$;
