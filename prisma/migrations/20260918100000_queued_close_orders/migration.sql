-- Closes respect DEALER mode (docs/CLOSES-RESPECT-DEALER-MODE.md, 2026-09-18).
--
-- Order.closesPositionId / closeVolume: a client's manual close (single, bulk, close-by,
-- partial) on a dealer-managed account no longer executes on the spot -- it becomes a
-- MARKET Order in the dealer queue that CLOSES closesPositionId (fully, or closeVolume lots),
-- exactly as an open does. Null on every existing / open order.
--
-- Position.closePendingOrderId: the lock -- the PENDING / REQUOTED close order awaiting the
-- dealer. Unique (one pending close per position); cleared on accept / reject / cancel /
-- desk auto-flush, and by the risk monitor when SL / TP / stop-out closes the position first.
--
-- Additive and default-safe: every existing row gets NULLs -- exactly today's behavior until
-- the routes start writing them. FKs SET NULL on delete so removing either row never blocks
-- on the pointer. Hand-written (never `prisma migrate dev` on this DB).

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "closesPositionId" TEXT,
ADD COLUMN "closeVolume" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Position" ADD COLUMN "closePendingOrderId" TEXT;

-- CreateIndex
CREATE INDEX "Order_closesPositionId_idx" ON "Order"("closesPositionId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_closePendingOrderId_key" ON "Position"("closePendingOrderId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_closesPositionId_fkey" FOREIGN KEY ("closesPositionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_closePendingOrderId_fkey" FOREIGN KEY ("closePendingOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
