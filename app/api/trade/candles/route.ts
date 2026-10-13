import { NextRequest, NextResponse } from "next/server";
import { symbolHiddenFromBroker } from "@/lib/synthetic-symbols";
import { demoCandles, isDemoSymbolName, type DemoTimeframe } from "@/lib/demo-prices";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { CANDLE_TIMEFRAMES, candleBeforeFrom, candleLimitFrom, fetchCandleHistory, type CandleTimeframe } from "@/lib/candles";

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
  // web6 (issue 17): paging back for a chart scrolled left
  const before = candleBeforeFrom(searchParams.get("before"));
  if (before === "invalid") {
    return NextResponse.json({ error: "before must be a positive integer (ms since epoch)" }, { status: 400 });
  }

  // synthetic symbols (lib/synthetic-symbols.ts): only the shadow-bot tenant's traders read their history; anyone else
  // gets what an unknown symbol gets (an empty history)
  if (await symbolHiddenFromBroker(prisma, session.brokerId, symbol)) {
    return NextResponse.json([], { headers: { "x-market-data-source": "none" } });
  }
  // QoreTrader demo (lib/demo-prices.ts): a q-symbol has no stored history; its candles are the same function the browser runs
  if (isDemoSymbolName(symbol)) {
    const limit = candleLimitFrom(searchParams.get("limit"));
    const list = demoCandles(symbol, timeframe as DemoTimeframe, before instanceof Date ? before.getTime() - 1 : Date.now(), limit);
    return NextResponse.json(list.map((c) => ({ symbol, timeframe, bucketStart: new Date(c.bucketStart).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close })), { headers: { "x-market-data-source": "demo" } });
  }
  const { candles, source } = await fetchCandleHistory(symbol, timeframe as CandleTimeframe, candleLimitFrom(searchParams.get("limit")), before);
  return NextResponse.json(candles, { headers: { "x-market-data-source": source } });
}
