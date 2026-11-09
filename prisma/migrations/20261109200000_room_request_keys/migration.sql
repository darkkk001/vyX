-- Trader's Room money forms (owner 2026-11-09): one key per Deposit / Withdraw / Transfer form load, so a repeated or
-- parallel POST with the same key returns the first answer and never creates a second request. Additive: one new table.
-- Revert: DROP TABLE "RoomRequestKey";
CREATE TABLE "RoomRequestKey" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoomRequestKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoomRequestKey_clientId_key_key" ON "RoomRequestKey"("clientId", "key");
CREATE INDEX "RoomRequestKey_createdAt_idx" ON "RoomRequestKey"("createdAt");
ALTER TABLE "RoomRequestKey" ADD CONSTRAINT "RoomRequestKey_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
