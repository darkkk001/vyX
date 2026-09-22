-- Auto-hedge (2026-09-23).
--
-- Broker."autoHedgeAt": null = off. Only acts while the desk is in auto-fill
-- (dealingDeskAutoFillAt set); every DEALING-group fill is then mirrored onto the
-- coverage account at the same price and that leg closes with the client's close.
--
-- Position."autoHedged": true on a coverage leg the platform opened, false on one
-- the dealer booked by hand. It decides who closes the leg.
--
-- Both are additive and default to the current behaviour: every existing broker has
-- auto-hedge off, and every existing coverage leg counts as dealer-booked (which is
-- what they all are -- BOOK NOW was the only way to create one before this).
ALTER TABLE "Broker" ADD COLUMN IF NOT EXISTS "autoHedgeAt" TIMESTAMPTZ(3);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "autoHedged" BOOLEAN NOT NULL DEFAULT false;

DO $$
DECLARE legs INT;
BEGIN
  SELECT COUNT(*) INTO legs FROM "Position" WHERE "autoHedged";
  RAISE NOTICE 'auto-hedged legs after migration: % (expect 0)', legs;
END $$;
