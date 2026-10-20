-- Deal model, Migration A (docs/POSITION-DEAL-MODEL.md section 3.3 step 1). Additive only: a new table, two enums, a
-- sequence and two nullable Position columns. Nothing existing is rewritten.
-- Revert: DROP TABLE "Deal" (drops deal_ticket_seq with it); DROP TYPE "DealEntry"; DROP TYPE "DealReason";
--         ALTER TABLE "Position" DROP COLUMN "initialVolume", DROP COLUMN "reversedFromPositionId";
CREATE TYPE "DealEntry" AS ENUM ('IN', 'OUT', 'OUT_BY', 'INOUT');

CREATE TYPE "DealReason" AS ENUM ('CLIENT', 'DEALER', 'ADMIN', 'SL', 'TP', 'STOP_OUT', 'BULK', 'MIRROR', 'COVERAGE', 'CLOSE_BY', 'REVERSE', 'EXPIRY');

-- Deal tickets are their own number space (8 digits; order / position tickets are 9).
CREATE SEQUENCE "deal_ticket_seq" AS BIGINT START WITH 10000001 INCREMENT BY 1;

CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "ticket" BIGINT NOT NULL DEFAULT nextval('deal_ticket_seq'::regclass),
    "brokerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "orderId" TEXT,
    "symbolId" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "entry" "DealEntry" NOT NULL,
    "reason" "DealReason" NOT NULL,
    "source" "OrderSource",
    "volume" DECIMAL(10,2) NOT NULL,
    "price" DECIMAL(18,5) NOT NULL,
    "profit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "commission" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "swap" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "byPositionId" TEXT,
    "transactionId" TEXT,
    "adminId" TEXT,
    "executedAt" TIMESTAMPTZ(3) NOT NULL,
    "voidedAt" TIMESTAMPTZ(3),
    "backfilled" BOOLEAN NOT NULL DEFAULT false,
    "backfillNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

ALTER SEQUENCE "deal_ticket_seq" OWNED BY "Deal"."ticket";

CREATE UNIQUE INDEX "Deal_ticket_key" ON "Deal"("ticket");
CREATE UNIQUE INDEX "Deal_transactionId_key" ON "Deal"("transactionId");
CREATE INDEX "Deal_accountId_executedAt_idx" ON "Deal"("accountId", "executedAt");
CREATE INDEX "Deal_positionId_idx" ON "Deal"("positionId");
CREATE INDEX "Deal_brokerId_executedAt_idx" ON "Deal"("brokerId", "executedAt");

ALTER TABLE "Position" ADD COLUMN "initialVolume" DECIMAL(10,2),
ADD COLUMN "reversedFromPositionId" TEXT;

CREATE UNIQUE INDEX "Position_reversedFromPositionId_key" ON "Position"("reversedFromPositionId");
