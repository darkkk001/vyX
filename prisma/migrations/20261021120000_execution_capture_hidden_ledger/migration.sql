-- Batch D (owner 2026-10-21). Additive only: safe under the code already deployed.

-- D-1: per-order execution capture (prisma/schema.prisma Order). Orders written before this keep every new column NULL:
-- requestedAt's default is set AFTER the column exists, so it applies to new rows only (no backfill).
ALTER TABLE "Order"
  ADD COLUMN "requestedAt" TIMESTAMPTZ(3),
  ADD COLUMN "executedAt" TIMESTAMPTZ(3),
  ADD COLUMN "clientIp" TEXT,
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "routing" TEXT,
  ADD COLUMN "executionMode" TEXT;
ALTER TABLE "Order" ALTER COLUMN "requestedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- D-2: the ledger rows of a deleted trade, hidden from every client-facing read.
ALTER TABLE "Transaction" ADD COLUMN "hiddenForPositionId" TEXT;

-- D-2: one PENDING void / delete / reverse request per position (a second request is refused). Partial index: Prisma's
-- schema cannot express it, lib/position-actions.ts requestPositionAction checks first and maps a race to the same answer.
CREATE UNIQUE INDEX "PositionActionRequest_one_pending_per_position" ON "PositionActionRequest" ("positionId") WHERE "status" = 'PENDING';
