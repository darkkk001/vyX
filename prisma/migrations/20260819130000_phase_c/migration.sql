-- Phase C: Notifications, default account currency/leverage.

ALTER TABLE "Broker" ADD COLUMN "defaultAccountCurrency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Broker" ADD COLUMN "defaultAccountLeverage" INTEGER NOT NULL DEFAULT 100;

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_brokerId_idx" ON "Notification"("brokerId");
CREATE INDEX "Notification_brokerId_readAt_idx" ON "Notification"("brokerId", "readAt");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
