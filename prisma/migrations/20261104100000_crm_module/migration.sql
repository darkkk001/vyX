-- CRM module (owner brief 2026-11-03), additive only
ALTER TABLE "Broker" ADD COLUMN "crmEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Broker" ADD COLUMN "leverageChangeReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Broker" ADD COLUMN "tierConfig" JSONB;
ALTER TABLE "Group" ADD COLUMN "planMinDeposit" DECIMAL(18,2);
ALTER TABLE "Group" ADD COLUMN "planMaxLeverage" INTEGER;
ALTER TABLE "Group" ADD COLUMN "planSpreadFrom" TEXT;
ALTER TABLE "Client" ADD COLUMN "clientNumber" SERIAL NOT NULL;
CREATE UNIQUE INDEX "Client_clientNumber_key" ON "Client"("clientNumber");
ALTER TABLE "Client" ADD COLUMN "lastLoginAt" TIMESTAMPTZ(3);
ALTER TABLE "Client" ADD COLUMN "prevLoginAt" TIMESTAMPTZ(3);
