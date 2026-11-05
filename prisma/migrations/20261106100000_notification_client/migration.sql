-- A client-facing notification with no account yet. Additive: null on every existing row.
ALTER TABLE "Notification" ADD COLUMN "clientId" TEXT;
CREATE INDEX "Notification_clientId_idx" ON "Notification"("clientId");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
