-- Rust cutover Stage 6, engine-down watchdog (docs/STAGE6-PLAN.md section 14). Additive and idempotent: one new table, nothing existing is touched.
-- The engine writes its heartbeat here every few seconds (UPDATE "beatAt" = clock_timestamp()). While the row is older than "staleAfterSecs" the
-- engine counts as DOWN: both the web and the engine treat every RUST-owned account as WEB-owned, inside every acting transaction. The seed row is
-- born stale (epoch), so until an engine has beaten, nobody counts it as alive.
CREATE TABLE IF NOT EXISTS "RiskEngineHeartbeat" (
  "name"           TEXT         NOT NULL,
  "beatAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "staleAfterSecs" INTEGER      NOT NULL DEFAULT 30,
  "engineVersion"  TEXT,
  "instance"       TEXT,
  CONSTRAINT "RiskEngineHeartbeat_pkey" PRIMARY KEY ("name"),
  CONSTRAINT "RiskEngineHeartbeat_staleAfterSecs_check" CHECK ("staleAfterSecs" >= 5)
);
INSERT INTO "RiskEngineHeartbeat" ("name", "beatAt") VALUES ('risk', TIMESTAMPTZ 'epoch') ON CONFLICT ("name") DO NOTHING;
