-- QoreBridge M5 (Phase 1 brief, failure path): when a hedge leg ends ESCALATED (the LP refused or timed out and
-- every retry / failover is used up), the broker's dealers get a notification at once. A trigger, so it fires
-- whoever writes the row (QoreBridge writes HedgeResult directly) and exactly once per leg: only on the change INTO
-- ESCALATED. Plain words only (brokers never see LP / FIX / bridge internals); the leg's technical reason stays in
-- HedgeResult.reason for super-admin telemetry. Additive: one function, one trigger, no rows written.
-- Revert: DROP TRIGGER hedge_result_escalated_notify ON "HedgeResult"; DROP FUNCTION hedge_result_escalated_notify();
CREATE OR REPLACE FUNCTION hedge_result_escalated_notify() RETURNS trigger AS $$
DECLARE
  i RECORD;
BEGIN
  IF NEW."status" <> 'ESCALATED' OR (TG_OP = 'UPDATE' AND OLD."status" = 'ESCALATED') THEN
    RETURN NEW;
  END IF;
  SELECT h."brokerId", h."positionId", h."symbol", h."side", h."kind" INTO i FROM "HedgeIntent" h WHERE h."id" = NEW."intentId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  INSERT INTO "Notification" ("id", "brokerId", "type", "title", "body", "entityType", "entityId")
  VALUES (
    'hn' || replace(gen_random_uuid()::text, '-', ''),
    i."brokerId",
    'HEDGE_ESCALATED',
    'Hedge not completed',
    'The liquidity provider did not complete the ' || CASE WHEN i."kind" = 'OPEN' THEN 'hedge' ELSE 'hedge reduction' END
      || ' for ' || trim(trailing '.' from trim(trailing '0' from (NEW."requestedVolume" - NEW."filledVolume")::text)) || ' lots '
      || i."symbol" || ' (' || i."side" || '). That volume is unhedged until a dealer acts.',
    'Position',
    i."positionId"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hedge_result_escalated_notify
AFTER INSERT OR UPDATE OF "status" ON "HedgeResult"
FOR EACH ROW EXECUTE FUNCTION hedge_result_escalated_notify();
