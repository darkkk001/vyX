-- Trader's Room per-broker security settings. Additive, one default for existing rows.
ALTER TABLE "Broker" ADD COLUMN "clientIdleMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Broker" ADD COLUMN "humanCheckEnabled" BOOLEAN NOT NULL DEFAULT false;
