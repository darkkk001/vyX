-- Consolidated native release, server part (owner 2026-11-04). Additive only.

-- web security batch 1 S1: a staff password reset confines the trader to choosing a new password
ALTER TABLE "Account" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- mandatory-update policy: the lowest version per broker and app
CREATE TABLE "BrokerAppMinVersion" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "minVersion" TEXT NOT NULL,
    "latestVersion" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "setByAdminId" TEXT,
    "setAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BrokerAppMinVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrokerAppMinVersion_brokerId_app_key" ON "BrokerAppMinVersion"("brokerId", "app");

-- manual positions (staff order brief): booked by a broker admin at a stated price and time, never filled against the market
ALTER TABLE "Position" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
