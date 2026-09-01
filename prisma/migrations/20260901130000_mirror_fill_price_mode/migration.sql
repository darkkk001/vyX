-- Mirror fill-price mode (fixes double-charged spread on internal-ledger
-- mirror targets). Additive only: new enum + a NOT NULL column with a
-- default on the existing MirrorRule table.

-- CreateEnum
CREATE TYPE "MirrorFillPriceMode" AS ENUM ('SOURCE_PRICE', 'MARKET');

-- AlterTable
ALTER TABLE "MirrorRule" ADD COLUMN "fillPriceMode" "MirrorFillPriceMode" NOT NULL DEFAULT 'SOURCE_PRICE';
