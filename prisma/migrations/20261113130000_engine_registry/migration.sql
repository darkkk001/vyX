-- Multi-engine control plane (owner 2026-11-13). Additive; dormant until the engine step (nothing reads the assignment yet, and the web's
-- owner rule only consults an engine once that engine writes its own heartbeat, lastBeatAt).
CREATE TYPE "EngineStatus" AS ENUM ('PLANNED', 'ACTIVE', 'DRAINING', 'RETIRED');

CREATE TABLE "Engine" (
    "id" VARCHAR(40) NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "gatewayUrl" TEXT NOT NULL,
    "status" "EngineStatus" NOT NULL DEFAULT 'PLANNED',
    "lastBeatAt" TIMESTAMPTZ(3),
    "lastBeatVersion" TEXT,
    "staleAfterSecs" INTEGER NOT NULL DEFAULT 30,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Engine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Broker" ADD COLUMN "engineId" VARCHAR(40);
CREATE INDEX "Broker_engineId_idx" ON "Broker"("engineId");
ALTER TABLE "Broker" ADD CONSTRAINT "Broker_engineId_fkey" FOREIGN KEY ("engineId") REFERENCES "Engine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EngineAssignmentLog" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "fromEngineId" VARCHAR(40),
    "toEngineId" VARCHAR(40),
    "adminId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EngineAssignmentLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EngineAssignmentLog_brokerId_createdAt_idx" ON "EngineAssignmentLog"("brokerId", "createdAt");
CREATE INDEX "EngineAssignmentLog_toEngineId_idx" ON "EngineAssignmentLog"("toEngineId");

-- What an engine serves: `SELECT broker_id FROM engine_broker_scope WHERE engine_id = $ENGINE_ID`. Only ACTIVE and DRAINING engines appear, so
-- a PLANNED or RETIRED engine (and an unassigned broker) serves nothing. The engine reads this view, not the tables, so they can change later.
CREATE VIEW "engine_broker_scope" AS
    SELECT e."id" AS engine_id, b."id" AS broker_id
    FROM "Engine" e JOIN "Broker" b ON b."engineId" = e."id"
    WHERE e."status" IN ('ACTIVE', 'DRAINING');

-- Initial data (owner 2026-11-13): today's engine on the France VPS, and exactly the brokers it serves today (risk authority RUST); the rest stay
-- unassigned. One history row per assigned broker. Idempotent.
INSERT INTO "Engine" ("id", "name", "region", "gatewayUrl", "status", "notes", "updatedAt")
VALUES ('eu-fr-1', 'France 1', 'Europe (France)', 'https://feed.vyxtrader.com', 'ACTIVE', 'The engine on the France VPS (registered 2026-11-13).', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "EngineAssignmentLog" ("id", "brokerId", "fromEngineId", "toEngineId", "adminId", "reason", "createdAt")
SELECT 'eal_seed_' || md5(b."id"), b."id", NULL, 'eu-fr-1', NULL, 'Initial assignment: a broker the France engine serves today (risk authority RUST)', CURRENT_TIMESTAMP
FROM "Broker" b WHERE b."riskAuthority" = 'RUST' AND b."engineId" IS NULL;
UPDATE "Broker" SET "engineId" = 'eu-fr-1' WHERE "riskAuthority" = 'RUST' AND "engineId" IS NULL;
