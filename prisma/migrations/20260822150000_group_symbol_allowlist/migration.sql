-- Opt-in per-group symbol allowlist. restrictSymbols defaults to false,
-- so every existing group's behavior is unchanged until a broker admin
-- explicitly turns it on for a group -- see Group.restrictSymbols's own
-- schema comment and lib/risk.ts's checkGroupAllowedSymbol.
ALTER TABLE "Group" ADD COLUMN "restrictSymbols" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "GroupSymbol" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupSymbol_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupSymbol_groupId_symbolId_key" ON "GroupSymbol"("groupId", "symbolId");

CREATE INDEX "GroupSymbol_groupId_idx" ON "GroupSymbol"("groupId");

ALTER TABLE "GroupSymbol" ADD CONSTRAINT "GroupSymbol_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupSymbol" ADD CONSTRAINT "GroupSymbol_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
