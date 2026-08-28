-- Book routing + tier classification per group, plus per-group-per-symbol
-- pricing overrides a broker sets manually. See GroupType/GroupTier's own
-- schema comments and GroupSymbolConfig's own schema comment.
CREATE TYPE "GroupType" AS ENUM ('LP', 'DEALING', 'DEMO');

CREATE TYPE "GroupTier" AS ENUM ('STANDARD', 'PRO', 'ECN', 'ZERO');

ALTER TABLE "Group" ADD COLUMN "groupType" "GroupType" NOT NULL DEFAULT 'DEALING';
ALTER TABLE "Group" ADD COLUMN "tier" "GroupTier" NOT NULL DEFAULT 'STANDARD';

CREATE TABLE "GroupSymbolConfig" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "spreadMarkup" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "commissionPerLot" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "swapLong" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "swapShort" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupSymbolConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupSymbolConfig_groupId_symbolId_key" ON "GroupSymbolConfig"("groupId", "symbolId");

CREATE INDEX "GroupSymbolConfig_groupId_idx" ON "GroupSymbolConfig"("groupId");

ALTER TABLE "GroupSymbolConfig" ADD CONSTRAINT "GroupSymbolConfig_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupSymbolConfig" ADD CONSTRAINT "GroupSymbolConfig_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
