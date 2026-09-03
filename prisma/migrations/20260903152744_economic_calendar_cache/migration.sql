-- Economic calendar fallback (VYX-CALENDAR-FALLBACK-V0): DB-backed cache
-- for the free ForexFactory JSON feed, one row per source. Hand-picked
-- from `prisma migrate diff` against the live DB -- NOT applied
-- verbatim, since that diff also contained a pile of unrelated
-- pre-existing drift (the Rust engine's own snake_case tables reading as
-- droppable, column-type nits elsewhere) -- see this project's own
-- migrate-dev gotcha: never trust the raw diff wholesale on this DB.

-- CreateTable
CREATE TABLE "EconomicCalendarCache" (
    "id" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomicCalendarCache_pkey" PRIMARY KEY ("id")
);
