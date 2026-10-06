import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { checkGroupAllowedSymbol, effectiveMinLot } from "@/lib/risk";

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

  // Phase 2 batch 6 (issue 272): a group with restrictSymbols on offers only its allowed symbols -- the same rule every
  // order is checked with (lib/risk.ts checkGroupAllowedSymbol); the picker used to list symbols the order then refused
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { group: { select: { restrictSymbols: true, minLotSize: true, allowedSymbols: { select: { symbolId: true } } } } },
  });
  const allowedIds = account?.group?.allowedSymbols.map((s) => s.symbolId) ?? [];
  const allowed = (symbolId: string) => !account?.group || checkGroupAllowedSymbol(account.group.restrictSymbols, allowedIds, symbolId) === null;
  const brokerSymbolRows = await prisma.brokerSymbol.findMany({
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
  // A symbol the account still HOLDS (an open position or a resting order) stays listed even when the group no longer
  // allows it: the terminal / WebTrader price and value those rows from this list (digits, contract size, quote
  // currency). It goes out as tradable: false, so the ticket and watchlist leave it out; the order path still refuses
  // new orders on it (lib/risk.ts checkGroupAllowedSymbol).
  const [heldPositions, heldOrders] = account?.group?.restrictSymbols
    ? await Promise.all([
        prisma.position.findMany({ where: { accountId: session.accountId, status: "OPEN" }, select: { symbolId: true }, distinct: ["symbolId"] }),
        prisma.order.findMany({ where: { accountId: session.accountId, status: "PENDING" }, select: { symbolId: true }, distinct: ["symbolId"] }),
      ])
    : [[], []];
  const held = new Set([...heldPositions, ...heldOrders].map((r) => r.symbolId));
  const brokerSymbols = brokerSymbolRows.filter((bs) => allowed(bs.symbol.id) || held.has(bs.symbol.id));

  return NextResponse.json({
    symbols: brokerSymbols.map((bs) => ({
      id: bs.symbol.id,
      name: bs.symbol.name,
      // false = listed only because the account still holds it (see above); older clients ignore the field
      tradable: allowed(bs.symbol.id),
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
      // Owner 2026-10-06: the smallest NEW order this account may place = the larger of the symbol minimum and its
      // group's minimum (lib/risk.ts effectiveMinLot, the same rule the order paths refuse with GROUP_MIN_VOLUME).
      // symbolMinLot is the symbol's own minimum: the step grid and partial closes still count from it.
      minLot: effectiveMinLot(bs.minLot, account?.group?.minLotSize ?? null).toString(),
      symbolMinLot: bs.minLot.toString(),
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
