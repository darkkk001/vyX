-- Rejected-order trace (app/api/trade/orders/route.ts -> lib/rejected-orders.ts). Additive only: a new table.
CREATE TABLE "RejectedOrder" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT,
    "volume" TEXT,
    "orderType" TEXT,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "platform" TEXT,
    "clientIp" TEXT,
    "source" "OrderSource",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RejectedOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RejectedOrder_brokerId_requestedAt_idx" ON "RejectedOrder"("brokerId", "requestedAt");
CREATE INDEX "RejectedOrder_accountId_requestedAt_idx" ON "RejectedOrder"("accountId", "requestedAt");
