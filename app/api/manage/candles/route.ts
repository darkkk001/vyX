import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { CANDLE_TIMEFRAMES, candleLimitFrom, fetchCandleHistory, type CandleTimeframe } from "@/lib/candles";

// Admin-authed OHLC history for the backoffice Dealing chart (panel 4 of
// the dealer workstation). Same global market data the account-authed
// trade route returns (fetchCandleHistory, lib/candles.ts) -- candles are
// keyed by symbol + timeframe, not by broker, so there is no broker filter
// on the data; the broker scope is only the admin session itself. Role set
// matches the other Dealing-screen endpoints (dealing-desk / dealing-queue:
// MANAGER, BROKER_ADMIN) so the chart is visible to exactly the roles that
// see the Dealing screen. getAdminSession also enforces the native-client
// build binding (X-Client-Build) + tenant (x-broker-id). See
// docs/DEALING-CHART-PLAN.md.
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
