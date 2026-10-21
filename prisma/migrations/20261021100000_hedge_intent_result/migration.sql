-- QoreBridge M5 (docs/qorebridge/00-current-state.md, "Hedge state and the deal model"): the hedge pipeline's two tables
-- and per-group routing. Additive only: two tables, three enums, three nullable/defaulted LpRoutingRule columns and a
-- view. Nothing existing is rewritten; no row is written by this migration.
--   HedgeIntent: one unit of hedge work per client deal on an A_BOOK position (dealId unique: one deal, one intent),
--     written by the web inside the deal's own transaction; claimed by QoreBridge with a lease.
--   HedgeResult: one row per leg (the part of an intent sent to one LP), written ROUTED by QoreBridge before the leg is
--     sent, then updated with the LP outcome. The LP fill price lives here, never on Position / Deal.
--   HedgeRoutingRule (view): LpRoutingRule as QoreBridge reads it (group, symbol name, LP, priority, weight).
-- Revert: DROP VIEW "HedgeRoutingRule"; DROP TABLE "HedgeResult"; DROP TABLE "HedgeIntent";
--         DROP TYPE "HedgeResultStatus"; DROP TYPE "HedgeIntentStatus"; DROP TYPE "HedgeIntentKind";
--         ALTER TABLE "LpRoutingRule" DROP COLUMN "groupId", DROP COLUMN "weight", DROP COLUMN "enabled";
CREATE TYPE "HedgeIntentKind" AS ENUM ('OPEN', 'CLOSE', 'VOID');

CREATE TYPE "HedgeIntentStatus" AS ENUM ('PENDING', 'CLAIMED', 'DONE', 'ERROR');

CREATE TYPE "HedgeResultStatus" AS ENUM ('ROUTED', 'FILLED', 'ESCALATED');

CREATE TABLE "HedgeIntent" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "brokerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "dealId" TEXT,
    "groupId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "volume" DECIMAL(10,2) NOT NULL,
    "clientPrice" DECIMAL(18,5),
    "kind" "HedgeIntentKind" NOT NULL,
    "reason" "DealReason",
    "status" "HedgeIntentStatus" NOT NULL DEFAULT 'PENDING',
    "leasedBy" TEXT,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HedgeIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HedgeIntent_seq_key" ON "HedgeIntent"("seq");
CREATE UNIQUE INDEX "HedgeIntent_dealId_key" ON "HedgeIntent"("dealId");
CREATE INDEX "HedgeIntent_brokerId_status_seq_idx" ON "HedgeIntent"("brokerId", "status", "seq");
CREATE INDEX "HedgeIntent_positionId_idx" ON "HedgeIntent"("positionId");

CREATE TABLE "HedgeResult" (
    "legId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "liquidityProviderId" TEXT NOT NULL,
    "status" "HedgeResultStatus" NOT NULL,
    "requestedVolume" DECIMAL(10,2) NOT NULL,
    "filledVolume" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "avgPrice" DECIMAL(18,5) NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lpOrderIds" TEXT NOT NULL DEFAULT '',
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HedgeResult_pkey" PRIMARY KEY ("legId")
);

CREATE INDEX "HedgeResult_intentId_idx" ON "HedgeResult"("intentId");
CREATE INDEX "HedgeResult_liquidityProviderId_createdAt_idx" ON "HedgeResult"("liquidityProviderId", "createdAt");

ALTER TABLE "LpRoutingRule" ADD COLUMN "groupId" TEXT,
ADD COLUMN "weight" DECIMAL(10,4) NOT NULL DEFAULT 1,
ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "LpRoutingRule_groupId_idx" ON "LpRoutingRule"("groupId");

ALTER TABLE "LpRoutingRule" ADD CONSTRAINT "LpRoutingRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE VIEW "HedgeRoutingRule" AS
SELECT r."id", r."brokerId", r."groupId", s."name" AS "symbol", r."liquidityProviderId" AS "lpId", r."priority", r."weight", r."enabled"
FROM "LpRoutingRule" r
LEFT JOIN "Symbol" s ON s."id" = r."symbolId";
