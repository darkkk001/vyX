-- web4 (issues.md 151, owner 2026-09-30): history of HIGH-impact economic events, recorded from this deploy forward,
-- for the risk radar's news-trading flag. Additive only: one new, empty, global (not broker-scoped) table.

CREATE TABLE IF NOT EXISTS "EconomicEvent" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventAt" TIMESTAMPTZ(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "EconomicEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EconomicEvent_sourceKey_key" ON "EconomicEvent"("sourceKey");
CREATE INDEX IF NOT EXISTS "EconomicEvent_eventAt_idx" ON "EconomicEvent"("eventAt");
CREATE INDEX IF NOT EXISTS "EconomicEvent_currency_eventAt_idx" ON "EconomicEvent"("currency", "eventAt");
