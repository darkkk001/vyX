-- D4/slippage batch: the ONE data step (owner rule: previewed, one transaction, guarded, audited). Run AFTER migration
-- 20261004090000_broker_slippage_points. Copies each broker's slippage cap from pips to points (x 10: a pip is 10
-- points on every live symbol, none has 0 digits -- preview section 2). Aborts on any mismatch with the preview.
-- Set the expected count first:   \set expected_brokers 0      (the preview's section 7 "brokers_with_cap")
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('d4.expected', :'expected_brokers', true);
DO $$
DECLARE
  expected int := current_setting('d4.expected')::int;
  n int := 0;
  r record;
  src jsonb := '{"source": "owner-approved direct write 2026-09-30 D4/slippage: max slippage pips -> points (x10)"}';
BEGIN
  IF EXISTS (SELECT 1 FROM "Symbol" s WHERE s.digits < 1 AND EXISTS (SELECT 1 FROM "BrokerSymbol" bs WHERE bs."symbolId" = s.id)) THEN
    RAISE EXCEPTION 'a 0-digit symbol is enabled: x10 is not exact for it, stop and re-plan';
  END IF;
  FOR r IN SELECT id, subdomain, "defaultMaxSlippagePips" AS pips, "defaultMaxSlippagePoints" AS points
           FROM "Broker" WHERE "defaultMaxSlippagePips" IS NOT NULL FOR UPDATE LOOP
    IF r.points IS NOT NULL AND r.points <> r.pips * 10 THEN
      RAISE EXCEPTION 'broker % already has points % that are not pips % x 10', r.subdomain, r.points, r.pips;
    END IF;
    IF r.points IS NULL THEN
      UPDATE "Broker" SET "defaultMaxSlippagePoints" = r.pips * 10, "updatedAt" = now() WHERE id = r.id;
      INSERT INTO "AuditLog" (id, "brokerId", "actorAdminId", action, "entityType", "entityId", "oldValue", "newValue", "createdAt")
      VALUES (gen_random_uuid()::text, r.id, NULL, 'RISK_LIMITS_UPDATED', 'Broker', r.id,
              jsonb_build_object('defaultMaxSlippagePips', r.pips::text, 'defaultMaxSlippagePoints', NULL),
              jsonb_build_object('defaultMaxSlippagePips', r.pips::text, 'defaultMaxSlippagePoints', (r.pips * 10)::text) || src, now());
    END IF;
    n := n + 1;
  END LOOP;
  IF n <> expected THEN RAISE EXCEPTION 'expected % brokers with a slippage cap, found %', expected, n; END IF;
  -- guard: every broker with a pips cap now has exactly pips x 10 points
  SELECT count(*) INTO n FROM "Broker" WHERE "defaultMaxSlippagePips" IS NOT NULL AND ("defaultMaxSlippagePoints" IS NULL OR "defaultMaxSlippagePoints" <> "defaultMaxSlippagePips" * 10);
  IF n <> 0 THEN RAISE EXCEPTION '% brokers not converted exactly', n; END IF;
  RAISE NOTICE 'ok: % brokers converted (pips x 10)', expected;
END $$;
COMMIT;
