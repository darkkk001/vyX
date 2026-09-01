-- Watchlist category-header collapsed state, server-side. Additive only:
-- one new array column, empty default (every category starts expanded).

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "watchlistCollapsedCategories" "SymbolCategory"[] NOT NULL DEFAULT ARRAY[]::"SymbolCategory"[];
