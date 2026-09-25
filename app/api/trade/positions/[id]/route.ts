import { NextRequest, NextResponse } from "next/server";
import { getLivePriceRow } from "@/lib/live-price";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { validateSlTp } from "@/lib/trading";
import { checkTradingSession, computeNextSessionOpen } from "@/lib/risk";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { isDealingManagedAccount } from "@/lib/dealing-routing";

// Inline SL/TP edit on an open position — side-aware validated against the
// client-reported current price, same rule as order placement.
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
  const slPrice = body?.slPrice !== undefined ? (body.slPrice == null ? null : String(body.slPrice)) : undefined;
  const tpPrice = body?.tpPrice !== undefined ? (body.tpPrice == null ? null : String(body.tpPrice)) : undefined;

  // currentPrice from the client is no longer trusted (audit 2026-09-24, money): SL/TP are checked against the
  // server's own live close-side price below. Older terminals still send it; it is ignored when a live price exists.

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

  const live = brokerSymbol ? await getLivePriceRow(brokerSymbol.symbol.name) : null;
  const serverClosePrice = live ? (position.side === "BUY" ? live.bid : live.ask).toString() : null;
  if (!serverClosePrice) {
    // no server price at all right now: refuse rather than trust the client's number
    return NextResponse.json({ error: "NO_LIVE_FEED", symbol: brokerSymbol?.symbol.name ?? null }, { status: 400 });
  }
  const validationError = validateSlTp({
    side: position.side,
    referencePrice: serverClosePrice,
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
