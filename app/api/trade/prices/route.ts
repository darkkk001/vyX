import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { checkTradingSession } from "@/lib/risk";

// Polled by the WebTrader client every couple seconds to blend real MT5
// ticks (see /api/internal/price-feed) into the otherwise-simulated market
// state. Symbols with no live tick yet simply stay simulated client-side.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const prices = await prisma.livePrice.findMany();
  // Session-enforcement pack -- lets the ticket UI disable Buy/Sell for a
  // closed-session symbol proactively, instead of only finding out from a
  // rejected order after the fact. Reuses this account's own broker's
  // BrokerSymbol/TradingSession config and the exact same checkTradingSession
  // the order-placement routes enforce with (lib/risk.ts) -- one source of
  // truth, read here instead of re-derived. `prices` above isn't scoped to
  // this broker (a pre-existing, separate concern, not touched here), so a
  // symbol this broker doesn't carry just falls back to "not closed" rather
  // than guessing.
  const brokerSymbols = await prisma.brokerSymbol.findMany({
    where: { brokerId: session.brokerId },
    include: { symbol: { select: { name: true } }, tradingSessions: true },
  });
  const now = new Date();
  const closedByName = new Map(
    brokerSymbols.map((bs) => [bs.symbol.name, checkTradingSession(bs.tradingSessions, now, bs.symbol.name) != null])
  );
  return NextResponse.json(prices.map((p) => ({ ...p, marketClosed: closedByName.get(p.symbol) ?? false })));
}
