import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

const TIMEFRAMES = new Set(["M1", "M5", "M30", "H1", "H4", "D1", "W1", "MN1", "Y1"]);
type Timeframe = "M1" | "M5" | "M30" | "H1" | "H4" | "D1" | "W1" | "MN1" | "Y1";

// Real OHLC history for the WebTrader chart, built from the same MT5 EA
// ticks that feed LivePrice (see lib/price-feed.ts). Returned oldest-first
// so the client can push straight into its candle array. A symbol with no
// feed history yet just returns an empty array — the client falls back to
// its synthetic seed in that case. Note W1/MN1/Y1 in particular will be
// sparse to empty for a long time after the feed first goes live — a
// weekly/monthly/yearly candle needs that much real elapsed time to exist
// at all, there's no way to backfill it from nothing.
export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const timeframe = searchParams.get("tf");
  if (!symbol || !timeframe || !TIMEFRAMES.has(timeframe)) {
    return NextResponse.json({ error: "symbol and a valid tf are required" }, { status: 400 });
  }

  const candles = await prisma.candle.findMany({
    where: { symbol, timeframe: timeframe as Timeframe },
    orderBy: { bucketStart: "desc" },
    take: 300,
  });
  candles.reverse();

  return NextResponse.json(candles);
}
