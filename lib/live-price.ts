import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type FreshPrice = { symbol: string; bid: Prisma.Decimal; ask: Prisma.Decimal };

// Same 15s staleness threshold as everywhere else this convention is
// used (WebTrader.tsx's chart, market_data::db::get_live_price,
// services/api-gateway's getOpenPositionsSummary) -- a frozen LivePrice
// row is worse than no price at all: computing P&L, an open fill, or a
// close off a dead feed could hide real exposure or move real balance
// off a wrong number, rather than just failing loudly.
//
// Filtered in raw SQL, not `prisma.livePrice.findMany` + a JS Date
// comparison, even though LivePrice.updatedAt is `@db.Timestamptz(3)`
// now (docs/database.md #6) and a JS-side comparison would work
// correctly today -- kept server-side anyway for the same reason the
// Rust engine's own staleness queries are: one clock (Postgres's own
// now()), no dependency on whatever machine happens to run this code.
export async function getFreshPrices(symbolNames: string[]): Promise<Map<string, FreshPrice>> {
  if (symbolNames.length === 0) return new Map();
  const rows = await prisma.$queryRaw<FreshPrice[]>`
    SELECT symbol, bid, ask FROM "LivePrice"
    WHERE symbol = ANY(${symbolNames}) AND "updatedAt" > now() - interval '15 seconds'
  `;
  return new Map(rows.map((r) => [r.symbol, r]));
}

export async function getFreshPrice(symbolName: string): Promise<FreshPrice | null> {
  const map = await getFreshPrices([symbolName]);
  return map.get(symbolName) ?? null;
}
