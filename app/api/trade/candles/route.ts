import { NextRequest, NextResponse } from "next/server";
import { getAccountSession } from "@/lib/account-auth";
import { CANDLE_TIMEFRAMES, candleLimitFrom, fetchCandleHistory, type CandleTimeframe } from "@/lib/candles";

// Real OHLC history for the WebTrader chart, built from the same MT5 EA
// ticks that feed LivePrice (see lib/price-feed.ts). Returned oldest-first
// so the client can push straight into its candle array. A symbol with no
// feed history yet just returns an empty array -- the client falls back to
// its synthetic seed in that case.
//
// The VPS/Neon read itself lives in lib/candles.ts (fetchCandleHistory),
// shared with the admin-authed backoffice route (app/api/manage/candles)
// so the two can never drift; this route only adds the account session.
export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const timeframe = searchParams.get("tf");
  if (!symbol || !timeframe || !CANDLE_TIMEFRAMES.has(timeframe)) {
    return NextResponse.json({ error: "symbol and a valid tf are required" }, { status: 400 });
  }

  const { candles, source } = await fetchCandleHistory(symbol, timeframe as CandleTimeframe, candleLimitFrom(searchParams.get("limit")));
  return NextResponse.json(candles, { headers: { "x-market-data-source": source } });
}
