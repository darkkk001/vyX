-- Dealer coverage account + BOOK NOW plumbing.
--
-- Broker.coverageAccountId: the single system Account this broker mirrors
-- offsetting legs onto (see Broker.coverageAccount / lib/coverage.ts).
-- Nullable + unique (one coverage account per broker); FK SET NULL on
-- delete so removing the account never blocks on the pointer.
--
-- Position.covered / coveredAt: a B-book client position has been hedged
-- via BOOK NOW -- the client position stays OPEN and untouched, this only
-- records the broker's hedge so a booked position leaves the Smart Dealer
-- Manager's unbooked list. Position.coveragePositionId: the mirror leg
-- created on the coverage account (self-relation), kept for unwind/audit.
--
-- Additive and default-safe: every existing Broker gets a null pointer,
-- every existing Position gets covered=false -- exactly today's behavior.
-- Hand-written (never `prisma migrate dev` on this DB).

-- AlterTable
ALTER TABLE "Broker" ADD COLUMN "coverageAccountId" TEXT;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN "covered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "coveredAt" TIMESTAMPTZ(3),
ADD COLUMN "coveragePositionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Broker_coverageAccountId_key" ON "Broker"("coverageAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_coveragePositionId_key" ON "Position"("coveragePositionId");

-- AddForeignKey
ALTER TABLE "Broker" ADD CONSTRAINT "Broker_coverageAccountId_fkey" FOREIGN KEY ("coverageAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_coveragePositionId_fkey" FOREIGN KEY ("coveragePositionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;
