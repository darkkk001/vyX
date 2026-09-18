import { NextRequest, NextResponse } from "next/server";
import { toFiniteDecimal, isFiniteDecimalString } from "@/lib/decimal-input";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { validateSlTp } from "@/lib/trading";
import { checkPriceFreshness, checkTradingSession, computeNextSessionOpen } from "@/lib/risk";
import { getLivePriceRow } from "@/lib/live-price";
import { closePriceFor } from "@/lib/trading";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { isDealingManagedAccount } from "@/lib/dealing-routing";

// Inline SL/TP edit on an open position -- side-aware validated against the
// SERVER's own live price (pentest 2026-09-18 #5: validating against the
// client-reported currentPrice let a client put a BUY's SL above the market
// by lying about the price; the SL never fills at its own level, the risk
// monitor closes at the real market, so no money moved -- but the stop-level
// and side rules were bypassable). The reference is closePriceFor(side): the
// price the SL/TP actually triggers on (bid for a BUY, ask for a SELL). The
// client's currentPrice is still required as a sanity/audit value only.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const currentPrice = body?.currentPrice != null ? String(body.currentPrice) : null;
  const slPrice = body?.slPrice !== undefined ? (body.slPrice == null ? null : String(body.slPrice)) : undefined;
  const tpPrice = body?.tpPrice !== undefined ? (body.tpPrice == null ? null : String(body.tpPrice)) : undefined;

  if (!currentPrice) {
    return NextResponse.json({ error: "currentPrice is required" }, { status: 400 });
  }
  for (const [name, value] of [["currentPrice", currentPrice], ["slPrice", slPrice], ["tpPrice", tpPrice]] as const) {
    if (value != null && !isFiniteDecimalString(value)) {
      return NextResponse.json({ error: `invalid ${name}` }, { status: 400 });
    }
  }

  const position = await prisma.position.findUnique({ where: { id } });
  if (!position || position.accountId !== session.accountId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId: position.brokerId, symbolId: position.symbolId } },
    include: { symbol: { select: { digits: true, name: true, category: true } }, tradingSessions: true },
  });

  // Same fix as position close (app/api/trade/positions/[id]/close/
  // route.ts, 2026-09-05): this route had NO server-side market-state
  // check at all, relying entirely on WebTrader.tsx's own client-side
  // `mm.live` gate, which conflates "market normally closed" with "feed
  // down" and always showed "No live feed for this symbol" for both. A
  // trader modifying SL/TP against a closed market's stale reference price
  // needs the same real MARKET_CLOSED + next-open-time answer close now
  // gives, not a false report that the feed itself is broken.
  const sessionError = checkTradingSession(brokerSymbol?.tradingSessions ?? [], new Date(), brokerSymbol?.symbol.category ?? "FOREX");
  if (sessionError) {
    const nextOpenAt = computeNextSessionOpen(brokerSymbol?.tradingSessions ?? [], new Date(), brokerSymbol?.symbol.category ?? "FOREX");
    return NextResponse.json({ error: sessionError, nextOpenAt: nextOpenAt.toISOString() }, { status: 400 });
  }

  const [account, brokerForActivity] = await Promise.all([
    prisma.account.findUnique({
      where: { id: position.accountId },
      select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } },
    }),
    prisma.broker.findUnique({ where: { id: session.brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } }),
  ]);

  // The server's price, never the client's, is what a rejection is based on
  // (same rule as app/api/trade/orders/[id]'s entry-price direction check).
  // A missing/stale feed refuses the edit rather than falling back to the
  // client's number.
  const livePrice = await getLivePriceRow(brokerSymbol?.symbol.name ?? "");
  const freshnessError = checkPriceFreshness(livePrice);
  if (freshnessError || !livePrice) {
    return NextResponse.json({ error: "NO_LIVE_FEED", symbol: brokerSymbol?.symbol.name ?? null, lastTickAt: livePrice?.tickAt?.toISOString() ?? null }, { status: 400 });
  }
  const referencePrice = closePriceFor(position.side, livePrice.bid, livePrice.ask);

  const validationError = validateSlTp({
    side: position.side,
    referencePrice,
    slPrice: slPrice === undefined ? position.slPrice : slPrice,
    tpPrice: tpPrice === undefined ? position.tpPrice : tpPrice,
    digits: brokerSymbol?.symbol.digits,
    stopLevel: brokerSymbol?.stopLevel,
  });
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const updated = await prisma.position.update({
    where: { id },
    data: {
      ...(slPrice !== undefined ? { slPrice } : {}),
      ...(tpPrice !== undefined ? { tpPrice } : {}),
    },
  });
  await publishTradingEvent("PositionModified", { position_id: id, account_id: session.accountId, broker_id: session.brokerId });
  if (account) {
    await recordDealerActivity(prisma, {
      brokerId: session.brokerId,
      accountId: session.accountId,
      accountNumber: account.accountNumber,
      accountFullName: account.fullName,
      isDealingGroup: isDealingManagedAccount({
        group: account.group,
        brokerDealingModeOn: !!brokerForActivity?.dealingModeAt,
        dealingDeskAutoFillOn: !!brokerForActivity?.dealingDeskAutoFillAt,
      }),
      action: "ORDER_MODIFIED",
      symbol: brokerSymbol?.symbol.name ?? "",
      side: position.side,
      volume: position.volume.toString(),
      values: {
        oldSlPrice: position.slPrice?.toString() ?? null,
        newSlPrice: slPrice === undefined ? (position.slPrice?.toString() ?? null) : slPrice,
        oldTpPrice: position.tpPrice?.toString() ?? null,
        newTpPrice: tpPrice === undefined ? (position.tpPrice?.toString() ?? null) : tpPrice,
        onOpenPosition: true,
      },
      positionId: id,
    });
  }
  return NextResponse.json(updated);
}
