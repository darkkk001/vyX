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
  limit = 300
): Promise<{ candles: unknown[]; source: CandleSource }> {
  const vpsSymbol = isVpsSymbol(symbol);
  if (vpsSymbol) {
    const vps = await fetchVpsCandles(symbol, timeframe, limit);
    if (vps) return { candles: vps, source: "vps" };
  }

  const candles = await prisma.candle.findMany({
    where: { symbol, timeframe: timeframe as CandleTimeframe },
    orderBy: { bucketStart: "desc" },
    take: limit,
  });
  candles.reverse();

  return { candles, source: vpsSymbol ? "neon-fallback" : "neon" };
}
