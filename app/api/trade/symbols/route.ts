import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// The trader terminal's own symbol universe -- every symbol this broker
// has enabled, full stop. Replaces lib/market-simulator.ts's hardcoded
// 10-symbol SYMBOL_DEFS array as the source of "what symbols exist":
// that array was the actual cause of a real bug (a 30-enabled-symbol
// broker only ever showing 10 in the terminal, since nothing anywhere
// queried BrokerSymbol at all). WebTrader.tsx uses this to seed its
// live-price market state and to power the "+ Add symbol" dialog; the
// separate /api/trade/watchlist endpoint is just an ordered SUBSET of
// this same universe.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const brokerSymbols = await prisma.brokerSymbol.findMany({
    where: { brokerId: session.brokerId, enabled: true },
    include: {
      symbol: { select: { id: true, name: true, category: true, digits: true, contractSize: true, quoteCurrency: true, baseCurrency: true } },
      // the trading schedule the server itself gates orders on (lib/risk.ts checkTradingSession) --
      // the desktop terminal evaluates the same rule locally so a closed market reads "market closed",
      // never "no live feed", before a request is even sent
      tradingSessions: { select: { dayOfWeek: true, openTime: true, closeTime: true }, orderBy: [{ dayOfWeek: "asc" }, { openTime: "asc" }] },
    },
    orderBy: { symbol: { name: "asc" } },
  });

  return NextResponse.json({
    symbols: brokerSymbols.map((bs) => ({
      id: bs.symbol.id,
      name: bs.symbol.name,
      category: bs.symbol.category,
      tradingSessions: bs.tradingSessions,
      digits: bs.symbol.digits,
      contractSize: bs.symbol.contractSize.toString(),
      // FX batch (docs/contracts/fx-and-market-week.md): money figures come out in the QUOTE currency and are converted
      // to the account currency with the server's rate (lib/fx.ts)
      quoteCurrency: bs.symbol.quoteCurrency,
      baseCurrency: bs.symbol.baseCurrency,
      // Chart interaction pack -- client-side preview only for the
      // draggable SL/TP/pending-entry lines' live red-flash-on-violation;
      // the server's own check (lib/trading.ts's validateSlTp /
      // validatePendingPriceDistance) is what's actually authoritative.
      stopLevel: bs.stopLevel,
      // Partial-close dialog's own lots/% validation -- same "client
      // preview, server stays authoritative" convention as stopLevel
      // above (lib/risk.ts's checkLotStep is what actually gates a real
      // order; this just lets the dialog reject an invalid amount before
      // a round trip instead of after).
      minLot: bs.minLot.toString(),
      maxLot: bs.maxLot.toString(),
      lotStep: bs.lotStep.toString(),
      // MT5 hedged margin (lib/margin.ts hedgedUsedMargin): the terminal / WebTrader account panel uses it so the
      // margin they show is the one the server stops out on. 200 = no reduction.
      hedgedMarginPct: bs.hedgedMarginPct.toString(),
      // Phase 2 batch 3: the symbol's side restriction (BOTH / BUY_ONLY / SELL_ONLY); the ticket disables the other side
      tradingMode: bs.tradingMode,
    })),
  });
}
