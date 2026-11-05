-- Leverage rules + HMR plugin (owner 2026-11-06). Additive only: every new column is nullable or has a default, so the
-- running web and the live engine keep working before and after this migration.
ALTER TABLE "Group" ADD COLUMN "flexibleLeverage" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Broker" ADD COLUMN "flexibleLeverageMinTrades" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Broker" ADD COLUMN "hmrEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Position" ADD COLUMN "openLeverage" INTEGER;

CREATE TABLE "HmrWindow" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "leverage" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "HmrWindow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HmrCorrelation" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "symbols" TEXT[],
    CONSTRAINT "HmrCorrelation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HmrWindow_brokerId_startsAt_endsAt_idx" ON "HmrWindow"("brokerId", "startsAt", "endsAt");
CREATE UNIQUE INDEX "HmrCorrelation_brokerId_currency_key" ON "HmrCorrelation"("brokerId", "currency");

ALTER TABLE "HmrWindow" ADD CONSTRAINT "HmrWindow_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HmrCorrelation" ADD CONSTRAINT "HmrCorrelation_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
