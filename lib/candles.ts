import { prisma } from "@/lib/prisma";
import { fetchVpsCandles, isVpsSymbol } from "@/lib/market-data-client";

// Shared OHLC history read used by BOTH the account-authed trade chart
// (app/api/trade/candles) and the admin-authed backoffice Dealing chart
// (app/api/manage/candles). Candle data is global market data -- keyed by
// symbol + timeframe, not by broker -- so the two routes differ only in
// their auth; the data read is identical and lives here so the two can
// never drift. See docs/DEALING-CHART-PLAN.md.
export const CANDLE_TIMEFRAMES = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1", "Y1"]);
export type CandleTimeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1" | "W1" | "MN1" | "Y1";

// The newest-N window a candle route serves. 300 is what the charts load;
// the native terminal's forming-candle reconcile (E:\vyxtrader
// fix/chart-open-reconcile) asks for `?limit=3` after every bucket rollover,
// so honouring a smaller limit turns that from a ~30 KB fetch into a 3-row
// one. Anything missing or non-numeric gets the default window.
// web6 (owner 2026-10-01, issue 17: "M1/M5 history before 30 Sep is missing"): a chart scrolling left pages back with
// `?before=<ms>` and may ask for up to CANDLE_LIMIT_MAX bars per page (the engine's own cap is 5000). A page the VPS store
// answers empty (older than its retention: M1 30 days, M5 180 days) falls back to Neon as before, which still holds
// the history up to 2026-09-14, so paging keeps going into that.
export const CANDLE_LIMIT_DEFAULT = 300;
export const CANDLE_LIMIT_MAX = 1500;
export function candleLimitFrom(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) return CANDLE_LIMIT_DEFAULT;
  return Math.min(n, CANDLE_LIMIT_MAX);
}

/** `?before=` (ms since epoch, exclusive upper bound on bucketStart): absent = the newest page; a value that is not a
 *  positive integer = "invalid" (the route answers 400 rather than silently serving the newest page). */
export function candleBeforeFrom(raw: string | null): Date | null | "invalid" {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return "invalid";
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

export type CandleSource = "vps" | "neon" | "neon-fallback";

/**
 * Newest-300 OHLC bars for a symbol/timeframe, returned oldest-first so a
 * client can push straight into its candle array. Reads the engine's own
 * store (lib/market-data-client) for VPS-migrated symbols, falling back to
 * Neon on any VPS miss (timeout/error/empty), exactly as the trade route
 * did inline before this refactor. A symbol with no history yet returns an
 * empty array. `source` says which store answered (surfaced as the
 * x-market-data-source response header so the switch can be verified per
 * symbol with one request).
 */
export async function fetchCandleHistory(
  symbol: string,
  timeframe: CandleTimeframe,
  limit = 300,
  before: Date | null = null
): Promise<{ candles: unknown[]; source: CandleSource }> {
  const vpsSymbol = isVpsSymbol(symbol);
  if (vpsSymbol) {
    const vps = await fetchVpsCandles(symbol, timeframe, limit, before);
    if (vps) return { candles: vps, source: "vps" };
  }

  const candles = await prisma.candle.findMany({
    where: { symbol, timeframe: timeframe as CandleTimeframe, ...(before ? { bucketStart: { lt: before } } : {}) },
    orderBy: { bucketStart: "desc" },
    take: limit,
  });
  candles.reverse();

  return { candles, source: vpsSymbol ? "neon-fallback" : "neon" };
}
