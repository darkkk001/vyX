-- Per-group close-only (2026-09-23).
--
-- Group."closeOnlyAt": non-null = accounts in this group may only close, not
-- open. The per-group twin of Broker."closeOnlyAt", enforced by
-- lib/risk.ts's checkGroupCloseOnly beside the existing checkGroupTradingHalted
-- at every order-open gate.
--
-- Additive and defaults to today's behaviour: every existing group is null,
-- i.e. not close-only, so nothing changes until someone sets it.
ALTER TABLE "Group" ADD COLUMN IF NOT EXISTS "closeOnlyAt" TIMESTAMPTZ(3);

DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM "Group" WHERE "closeOnlyAt" IS NOT NULL;
  RAISE NOTICE 'groups in close-only after migration: % (expect 0)', n;
END $$;
