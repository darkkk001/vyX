import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { checkTradingSession } from "@/lib/risk";
import { pipSize } from "@/lib/group-pricing";
import { resolvePricingV2, resolveEffectiveSpreadMarkup } from "@/lib/pricing-engine";

// Polled by the WebTrader client every couple seconds to blend real MT5
// ticks (see /api/internal/price-feed) into the otherwise-simulated market
// state. Symbols with no live tick yet simply stay simulated client-side.
//
// 2026-09-05 real bug fixed here: this response carried no Cache-Control
// header at all, so a broker changing a group's spread markup wasn't
// reflected on the trader's terminal until a HARD refresh (which bypasses
// the browser's HTTP cache) -- a normal reload or the 30s poll interval
// alone could keep silently reusing a cached response for this exact URL.
// `force-dynamic` also guards against Next.js's own route-handler caching
// independent of the browser. Every value here (price, markup, market-
// closed status) must always be live -- there is no correct case for a
// trading terminal to ever be served a stale response for this route.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const [account, broker] = await Promise.all([
    prisma.account.findUnique({ where: { id: session.accountId }, select: { groupId: true, accountTypeId: true } }),
    prisma.broker.findUnique({ where: { id: session.brokerId }, select: { pricingEngineEnabled: true } }),
  ]);

  // 2026-09-05 P0 fix -- scoped to this broker's own enabled symbol
  // catalog now, not every LivePrice row on the whole platform regardless
  // of broker (the old comment below flagged this as "a pre-existing,
  // separate concern, not touched here" -- resolving per-account markup
  // needs each BrokerSymbol's own config anyway, so this is the natural
  // point to also stop over-fetching symbols this broker doesn't even
  // carry).
  const brokerSymbols = await prisma.brokerSymbol.findMany({
    where: { brokerId: session.brokerId, enabled: true },
    include: { symbol: { select: { id: true, name: true, digits: true, category: true } }, tradingSessions: true },
  });
  const now = new Date();
  const closedByName = new Map(
    brokerSymbols.map((bs) => [bs.symbol.name, checkTradingSession(bs.tradingSessions, now, bs.symbol.category) != null])
  );

  const prices = await prisma.livePrice.findMany({
    where: { symbol: { in: brokerSymbols.map((bs) => bs.symbol.name) } },
  });
  const priceByName = new Map(prices.map((p) => [p.symbol, p]));

  // Resolve each symbol's effective spread markup for THIS account (group
  // override, falling back to the broker default) -- the same precedence
  // lib/group-pricing.ts's resolveSymbolPricing applies at fill time, so
  // what the trader is quoted always agrees with what they'll actually
  // pay. Batched (2-4 queries total depending on the flag below, never
  // one per symbol) since this route runs on every poll.
  //
  // Deliberately exposed as a separate `askMarkup` delta, NOT baked into
  // `ask` itself: markup only ever applies to an OPENING fill on the ask
  // side (a BUY -- a SELL opens at raw bid, unmarked; see
  // lib/group-pricing.ts's applySpreadMarkup), and NEVER to a close,
  // either side (lib/position-close.ts's closePositionInTx never touches
  // spread at all). If this route baked markup into `ask` directly, every
  // consumer of the shared client market state that needs a true CLOSE
  // reference -- an open SELL position's floating P&L, margin, SL/TP
  // preview -- would silently inherit a wrong number. The client applies
  // this delta explicitly (lib/trade-api.ts's effectiveAsk), only at the
  // specific "about to open a BUY" call sites.
  const symbolIds = brokerSymbols.map((bs) => bs.symbolId);
  const overrides = account?.groupId
    ? await prisma.groupSymbolConfig.findMany({ where: { groupId: account.groupId, symbolId: { in: symbolIds } } })
    : [];
  const overrideBySymbolId = new Map(overrides.map((o) => [o.symbolId, o]));

  // Stage 4 flag-consistency fix (2026-09-07): a broker with
  // pricingEngineEnabled true gets the SAME full-resolution quote here
  // that a real fill would use -- previously this route always quoted the
  // old group-only markup regardless of the flag, so a flag-on broker's
  // trader could see one number and fill at another. Batched exactly like
  // the flag-off path above (accountType flat + AccountTypeSymbolConfig +
  // AccountSymbolConfig fetched ONCE for every symbol, never per-symbol)
  // -- pure resolvePricingV2 is then called in-memory per symbol, no
  // further I/O, so this stays a small constant number of queries
  // regardless of how many symbols the broker carries.
  let accountTypeFlat: { spreadMarkup: Prisma.Decimal | null; commissionPerLot: Prisma.Decimal | null; swapLong: Prisma.Decimal | null; swapShort: Prisma.Decimal | null; swapFree: boolean | null } | null = null;
  let accountTypeSymbolConfigBySymbolId = new Map<string, Awaited<ReturnType<typeof prisma.accountTypeSymbolConfig.findMany>>[number]>();
  let accountSymbolConfigBySymbolId = new Map<string, Awaited<ReturnType<typeof prisma.accountSymbolConfig.findMany>>[number]>();
  if (broker?.pricingEngineEnabled) {
    const [typeFlat, typeSymbolConfigs, accountSymbolConfigs] = await Promise.all([
      account?.accountTypeId ? prisma.accountType.findUnique({ where: { id: account.accountTypeId } }) : Promise.resolve(null),
      account?.accountTypeId
        ? prisma.accountTypeSymbolConfig.findMany({ where: { accountTypeId: account.accountTypeId, symbolId: { in: symbolIds } } })
        : Promise.resolve([]),
      prisma.accountSymbolConfig.findMany({ where: { accountId: session.accountId, symbolId: { in: symbolIds } } }),
    ]);
    accountTypeFlat = typeFlat;
    accountTypeSymbolConfigBySymbolId = new Map(typeSymbolConfigs.map((c) => [c.symbolId, c]));
    accountSymbolConfigBySymbolId = new Map(accountSymbolConfigs.map((c) => [c.symbolId, c]));
  }

  const askMarkupByName = new Map<string, string>();
  for (const bs of brokerSymbols) {
    const override = overrideBySymbolId.get(bs.symbolId);
    let markupPips: Prisma.Decimal;
    if (broker?.pricingEngineEnabled) {
      const resolved = resolvePricingV2({
        accountSymbolConfig: accountSymbolConfigBySymbolId.get(bs.symbolId) ?? null,
        accountTypeSymbolConfig: accountTypeSymbolConfigBySymbolId.get(bs.symbolId) ?? null,
        accountType: accountTypeFlat,
        groupSymbolConfig: override ?? null,
        brokerSpreadMarkup: bs.spreadMarkup,
        brokerCommissionPerLot: bs.commissionPerLot,
        brokerSwapLong: bs.swapLong,
        brokerSwapShort: bs.swapShort,
        accountSwapFree: null, // swap-free isn't shown by this route, not resolved here
        groupSwapFree: null,
      });
      const tick = priceByName.get(bs.symbol.name);
      const liveBaseSpreadPips = tick ? tick.ask.sub(tick.bid).div(pipSize(bs.symbol.digits)) : null;
      markupPips = resolveEffectiveSpreadMarkup(resolved.spread, liveBaseSpreadPips).markup;
    } else {
      // Per-field fallback (2026-09-07 migration pricing_engine_nullable_widening
      // made GroupSymbolConfig.spreadMarkup nullable) -- an override row with
      // this field null falls through to the broker default, same as no row
      // at all. No existing row has ever stored null, so this is a no-op today.
      markupPips = override?.spreadMarkup ?? bs.spreadMarkup;
    }
    if (markupPips.isZero()) continue;
    askMarkupByName.set(bs.symbol.name, markupPips.mul(pipSize(bs.symbol.digits)).toString());
  }
  return NextResponse.json(
    prices.map((p) => ({
      ...p,
      marketClosed: closedByName.get(p.symbol) ?? false,
      askMarkup: askMarkupByName.get(p.symbol) ?? "0",
    })),
    { headers: { "Cache-Control": "no-store" } }
  );
}
