-- Phase 2 pricing engine, Stage 1b: widen existing pricing columns to
-- nullable (null = "not set, fall through to next resolution level") and
-- add GroupSymbolConfig.targetTotalSpreadPips. DROP NOT NULL / DROP
-- DEFAULT only -- no USING clause, no data rewrite, every existing row's
-- literal stored value (0 / false) is preserved exactly as-is. Separate
-- migration from 20260907120000_pricing_engine_new_tables_and_flag
-- deliberately -- these ALTER a table with a live column, that one only
-- creates new objects.

-- AlterTable
ALTER TABLE "Account" ALTER COLUMN "swapFree" DROP NOT NULL,
ALTER COLUMN "swapFree" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AccountType" ALTER COLUMN "spreadMarkup" DROP NOT NULL,
ALTER COLUMN "spreadMarkup" DROP DEFAULT,
ALTER COLUMN "commissionPerLot" DROP NOT NULL,
ALTER COLUMN "commissionPerLot" DROP DEFAULT,
ALTER COLUMN "swapLong" DROP NOT NULL,
ALTER COLUMN "swapLong" DROP DEFAULT,
ALTER COLUMN "swapShort" DROP NOT NULL,
ALTER COLUMN "swapShort" DROP DEFAULT,
ALTER COLUMN "swapFree" DROP NOT NULL,
ALTER COLUMN "swapFree" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Group" ALTER COLUMN "swapFree" DROP NOT NULL,
ALTER COLUMN "swapFree" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GroupSymbolConfig" ADD COLUMN     "targetTotalSpreadPips" DECIMAL(10,4),
ALTER COLUMN "spreadMarkup" DROP NOT NULL,
ALTER COLUMN "spreadMarkup" DROP DEFAULT,
ALTER COLUMN "commissionPerLot" DROP NOT NULL,
ALTER COLUMN "commissionPerLot" DROP DEFAULT,
ALTER COLUMN "swapLong" DROP NOT NULL,
ALTER COLUMN "swapLong" DROP DEFAULT,
ALTER COLUMN "swapShort" DROP NOT NULL,
ALTER COLUMN "swapShort" DROP DEFAULT;
