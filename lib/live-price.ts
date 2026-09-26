import "server-only";
import { Prisma, type LivePrice, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchVpsPrice, fetchVpsPrices, type EnginePrice } from "@/lib/market-data-client";

export type FreshPrice = { symbol: string; bid: Prisma.Decimal; ask: Prisma.Decimal };

// The one place the web app reads a live price. Two backends:
//
//   * Neon's LivePrice table -- what every caller read before 2026-09-15
//     (the engine flushes its tick cache there every 250 ms).
//   * The engine's own tick cache over GET /internal/prices[/{symbol}]
//     (lib/market-data-client) -- the Neon -> VPS market-data migration's
//     stage S4 (docs/market-data.md §8). Enabled by MARKET_DATA_PRICES=vps;
//     any failure of that call falls back to Neon, so with the engine
//     dual-writing (MARKET_DATA_WRITE=both) the switch is reversible at
//     any moment and never a data loss. This is also what removes the
//     order path's DB flush lag (PRICE_STALE on fast clicks): the engine
//     answers with the tick it holds in memory, not the row it last wrote.
//
// Same 15s staleness threshold as everywhere else this convention is
// used (WebTrader.tsx's chart, market_data::db::get_live_price,
// services/api-gateway's getOpenPositionsSummary) -- a frozen price is
// worse than no price at all: computing P&L, an open fill, or a close off
// a dead feed could hide real exposure or move real balance off a wrong
// number, rather than just failing loudly.
//
// Filters on "tickAt", not "updatedAt" -- see that column's own schema
// comment. "updatedAt" bumps on every row write regardless of whether the
// underlying price changed (the MT5 EA's heartbeat resends an unchanged
// price every 5s), which left this blind to a genuinely stale feed as
// long as it kept heartbeating -- exactly the gap behind SL/TP/stop-out
// evaluation (this function's callers: lib/risk-monitor.ts) firing off a
// frozen price. "tickAt" only advances when the market's own last tick
// actually does. The engine's row carries the same tickAt (the tick's own
// EA time, UTC), so the gate means the same thing on both backends.
//
// Neon branch filtered in raw SQL, not `prisma.livePrice.findMany` + a JS
// Date comparison -- one clock (Postgres's own now()), no dependency on
// whatever machine runs this code. The engine branch necessarily compares
// in JS (the engine has no DB on that path); Vercel's clock is NTP-synced,
// and a 15 s window has ample slack for that.

const FRESH_MAX_AGE_MS = 15_000;

/** The Neon fallback runs on the caller's own client when it has one (a
 * transaction in lib/mirror.ts / lib/risk.ts) so it sees rows that
 * transaction wrote, exactly as the direct `db.livePrice.findUnique` did. */
type Db = PrismaClient | Prisma.TransactionClient;

/** True when live-price reads go to the engine first (MARKET_DATA_PRICES=vps). */
export function pricesFromVps(): boolean {
  return (process.env.MARKET_DATA_PRICES ?? "").trim().toLowerCase() === "vps";
}

/** Engine wire row -> the Prisma LivePrice runtime row every caller already handles. */
export function toLivePriceRow(p: EnginePrice): LivePrice | null {
  try {
    const bid = new Prisma.Decimal(p.bid);
    const ask = new Prisma.Decimal(p.ask);
    const tickAt = new Date(p.tickAt);
    const updatedAt = new Date(p.updatedAt);
    if (!bid.isFinite() || !ask.isFinite() || Number.isNaN(tickAt.getTime()) || Number.isNaN(updatedAt.getTime())) return null;
    return { symbol: p.symbol, bid, ask, tickAt, updatedAt };
  } catch {
    return null;
  }
}

/**
 * One symbol's current LivePrice-shaped row, no freshness filter (the
 * caller decides -- lib/risk.ts's evaluateLiveMarketPrice / checkPriceFreshness).
 * null = no price known anywhere.
 */
export async function getLivePriceRow(symbolName: string, db: Db = prisma): Promise<LivePrice | null> {
  if (pricesFromVps()) {
    const p = await fetchVpsPrice(symbolName);
    const row = p ? toLivePriceRow(p) : null;
    if (row) return row;
    // engine unreachable, or no tick for the symbol in its cache -> Neon
  }
  return db.livePrice.findUnique({ where: { symbol: symbolName } });
}

export type PriceSource = "vps" | "neon" | "neon-fallback";

/**
 * Every listed symbol's current row (no freshness filter), keyed by symbol,
 * plus which backend answered (surfaced as the x-market-data-source header
 * by /api/trade/prices so the switch can be verified with one curl).
 */
export async function getLivePriceRowsWithSource(symbolNames: string[], db: Db = prisma): Promise<{ rows: Map<string, LivePrice>; source: PriceSource }> {
  if (symbolNames.length === 0) return { rows: new Map(), source: pricesFromVps() ? "vps" : "neon" };
  const wanted = new Set(symbolNames);
  const vps = pricesFromVps();
  if (vps) {
    const all = await fetchVpsPrices();
    if (all) {
      const map = new Map<string, LivePrice>();
      for (const p of all) {
        if (!wanted.has(p.symbol)) continue;
        const row = toLivePriceRow(p);
        if (row) map.set(row.symbol, row);
      }
      if (map.size > 0) return { rows: map, source: "vps" };
    }
  }
  const rows = await db.livePrice.findMany({ where: { symbol: { in: symbolNames } } });
  return { rows: new Map(rows.map((r) => [r.symbol, r])), source: vps ? "neon-fallback" : "neon" };
}

/**
 * Idle gate for the full margin pass (Neon load, 2026-09-26): does ANY symbol have a fresh (15 s) tick right now?
 * Answered from the engine's tick cache alone (no database), so a closed market costs the caller nothing. null =
 * unknown (not reading from the VPS, or the engine unreachable): the caller must go on as before.
 */
export async function anyFreshPriceOnVps(): Promise<boolean | null> {
  if (!pricesFromVps()) return null;
  const all = await fetchVpsPrices();
  if (!all) return null;
  const cutoff = Date.now() - FRESH_MAX_AGE_MS;
  return all.some((p) => {
    const row = toLivePriceRow(p);
    return row != null && row.tickAt.getTime() > cutoff;
  });
}

export async function getLivePriceRows(symbolNames: string[], db: Db = prisma): Promise<Map<string, LivePrice>> {
  return (await getLivePriceRowsWithSource(symbolNames, db)).rows;
}

/**
 * Fresh (tick within the last 15 s) bid/ask for the requested symbols,
 * keyed by symbol; a symbol with no fresh tick is simply absent -- the
 * signal every caller (margin, risk monitor, bulk close, dealing queue,
 * mirror, manage positions) already treats as "no live price: skip / refuse".
 */
export async function getFreshPrices(symbolNames: string[]): Promise<Map<string, FreshPrice>> {
  if (symbolNames.length === 0) return new Map();
  if (pricesFromVps()) {
    const rows = await getLivePriceRows(symbolNames);
    if (rows.size > 0) {
      const cutoff = Date.now() - FRESH_MAX_AGE_MS;
      const map = new Map<string, FreshPrice>();
      for (const r of rows.values()) {
        if (r.tickAt.getTime() > cutoff) map.set(r.symbol, { symbol: r.symbol, bid: r.bid, ask: r.ask });
      }
      return map;
    }
  }
  const rows = await prisma.$queryRaw<FreshPrice[]>`
    SELECT symbol, bid, ask FROM "LivePrice"
    WHERE symbol = ANY(${symbolNames}) AND "tickAt" > now() - interval '15 seconds'
  `;
  return new Map(rows.map((r) => [r.symbol, r]));
}

/**
 * No usable tick for `symbolName` although its trading schedule says OPEN (2026-09-25). Two very different causes:
 * - the FEED is down: nothing is ticking anywhere -> "NO_LIVE_FEED" (a real problem, say so);
 * - this MARKET is not quoting while the feed is alive (other symbols ticked in the last 15 s): the minutes after the
 *   daily break / weekend reopen before its first tick, an exchange holiday, an early close the schedule does not
 *   know -> "MARKET_CLOSED". A trader closing a position then sees "market closed", not "feed gap, last tick 62
 *   minutes ago", which read as the platform being broken.
 * Only ever called on the error path (a missing price), so the extra read costs nothing in normal trading.
 */
export async function classifyMissingPrice(brokerId: string, symbolName: string): Promise<"MARKET_CLOSED" | "NO_LIVE_FEED"> {
  const rows = await prisma.brokerSymbol.findMany({ where: { brokerId, enabled: true }, select: { symbol: { select: { name: true } } } });
  const others = rows.map((r) => r.symbol.name).filter((n) => n !== symbolName);
  if (others.length === 0) return "NO_LIVE_FEED";
  const fresh = await getFreshPrices(others).catch(() => new Map<string, FreshPrice>());
  return fresh.size > 0 ? "MARKET_CLOSED" : "NO_LIVE_FEED";
}

export async function getFreshPrice(symbolName: string): Promise<FreshPrice | null> {
  const map = await getFreshPrices([symbolName]);
  return map.get(symbolName) ?? null;
}
