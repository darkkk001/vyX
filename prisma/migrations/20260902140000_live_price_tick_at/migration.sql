-- LivePrice.tickAt: the real last-tick time (see the schema field's own
-- comment on why "updatedAt" alone can't be trusted as a staleness
-- signal). Additive only: one new column, defaulted so existing rows
-- backfill cleanly; every subsequent write sets it explicitly.

-- AlterTable
ALTER TABLE "LivePrice" ADD COLUMN     "tickAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now();
