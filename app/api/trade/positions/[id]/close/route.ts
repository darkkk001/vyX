import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { closePositionInTx } from "@/lib/position-close";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { isDealingManagedAccount } from "@/lib/dealing-routing";
import { checkLiveMarketPrice, checkLotStep, checkTradingSession, computeNextSessionOpen } from "@/lib/risk";
import * as mirror from "@/lib/mirror";

// Closing (fully or partially) is the one place a trade changes the
// account balance. Realized P&L is computed server-side and applied
// atomically alongside a ledger Transaction row — never a silent balance
// overwrite. A partial close (volume < position.volume) reduces the
// position's volume and keeps it OPEN rather than closing it outright;
// the Transaction row is still the authoritative record of what was
// realized and when.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const closePrice = body?.closePrice != null ? String(body.closePrice) : null;
  if (!closePrice) {
    return NextResponse.json({ error: "closePrice is required" }, { status: 400 });
  }
  // Informational only, doesn't change validation/execution -- flags this
  // close for the STM_BULK_CLOSE audit trail. See
  // components/webtrader/SmartTradeManager.tsx's runBulk/partialCloseOne/
  // closeOne and docs/webtrader-stm-architecture-review.md §4.6.
  const source = body?.source === "stm_bulk" ? "stm_bulk" : null;

  const position = await prisma.position.findUnique({
    where: { id },
    include: {
      symbol: { select: { id: true, name: true, contractSize: true } },
      account: { select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } } },
    },
  });
  if (!position || position.accountId !== session.accountId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }

  // Real bug fixed here (2026-09-05): this route never checked whether the
  // symbol's market was actually open at all -- a close outside trading
  // hours fell straight through to checkLiveMarketPrice below, which (with
  // no fresh LivePrice tick, since nothing feeds a closed market) always
  // rejected as "no live feed", so a trader reading that message thought
  // the system was broken rather than the market being routinely closed
  // (e.g. every weekend). checkTradingSession now runs first and returns
  // the real reason -- MARKET_CLOSED with the actual next-open time from
  // this symbol's own TradingSession config -- distinguishing it from a
  // genuine feed outage (market OPEN, feed down), which is what
  // checkLiveMarketPrice below still guards, now correctly scoped to only
  // that rarer case.
  const brokerSymbol = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId: session.brokerId, symbolId: position.symbol.id } },
    include: { tradingSessions: true },
  });
  const sessionError = checkTradingSession(brokerSymbol?.tradingSessions ?? [], new Date(), position.symbol.name);
  if (sessionError) {
    const nextOpenAt = computeNextSessionOpen(brokerSymbol?.tradingSessions ?? [], new Date());
    return NextResponse.json({ error: sessionError, nextOpenAt: nextOpenAt.toISOString() }, { status: 400 });
  }

  const priceError = await checkLiveMarketPrice(prisma, position.symbol.name, closePrice);
  if (priceError) {
    return NextResponse.json({ error: priceError }, { status: 400 });
  }

  let closeVolume = position.volume;
  if (body?.volume != null) {
    let requested: Prisma.Decimal;
    try {
      requested = new Prisma.Decimal(String(body.volume));
    } catch {
      return NextResponse.json({ error: "invalid volume" }, { status: 400 });
    }
    if (requested.lte(0) || requested.gt(position.volume)) {
      return NextResponse.json(
        { error: `volume must be between 0 and ${position.volume}` },
        { status: 400 }
      );
    }
    // Partial close (item 9 of the terminal live-findings pack) -- a
    // partial amount that isn't itself a tradeable lot size (or that
    // leaves a dangling remainder that isn't) was previously accepted
    // outright; nothing here ever checked it, unlike order creation's
    // own checkLotStep gate. A full close (requested === position.volume)
    // skips this -- there's no remainder to be invalid, and a position
    // opened before minLot/lotStep were configured (or before they
    // changed) must always still be fully closeable.
    if (!requested.equals(position.volume)) {
      if (brokerSymbol) {
        const stepError = checkLotStep(requested, brokerSymbol.minLot, brokerSymbol.lotStep);
        if (stepError) {
          return NextResponse.json({ error: `partial close amount ${stepError}` }, { status: 400 });
        }
        const remaining = position.volume.sub(requested);
        if (remaining.gt(0) && remaining.lt(brokerSymbol.minLot)) {
          return NextResponse.json(
            { error: `closing this amount would leave ${remaining} lots open, below this symbol's minimum of ${brokerSymbol.minLot} -- close the full position instead` },
            { status: 400 }
          );
        }
      }
    }
    closeVolume = requested;
  }
  const outcome = await prisma.$transaction((tx) =>
    closePositionInTx(tx, {
      position: {
        id: position.id,
        accountId: session.accountId,
        brokerId: session.brokerId,
        side: position.side,
        openPrice: position.openPrice,
        volume: position.volume,
        symbol: { contractSize: position.symbol.contractSize },
      },
      closePrice,
      closeVolume,
    })
  );

  if (!outcome.closed) {
    // Lost a race with a concurrent close (another tab, or the risk
    // monitor's own SL/TP/stop-out closing the same position at the same
    // instant) between the read above and the transaction's own guarded
    // UPDATE. The position is genuinely closed/reduced already, just not
    // by this call -- report the current state, not a false success.
    return NextResponse.json({ error: "position was already closed" }, { status: 409 });
  }

  if (source === "stm_bulk") {
    await prisma.auditLog.create({
      data: {
        brokerId: session.brokerId,
        action: "STM_BULK_CLOSE",
        entityType: "Position",
        entityId: position.id,
        oldValue: { volume: position.volume.toString() },
        newValue: { closeVolume: closeVolume.toString(), partial: outcome.partial },
      },
    });
  }
  // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- after this route's own
  // transaction has committed, never inside it (same reasoning as the
  // fill-path hook in app/api/trade/orders/route.ts). `position.volume`
  // here is still this route's own top-of-function read, from before
  // closePositionInTx reduced/closed the row -- exactly the "source
  // volume before this close" onClose needs to compute a proportional
  // close on the mirrored side.
  await mirror.onClose(prisma, {
    positionId: position.id,
    brokerId: session.brokerId,
    closedLots: closeVolume,
    sourceVolumeBeforeClose: position.volume,
    closePrice: new Prisma.Decimal(closePrice),
  }).catch((err) => console.error("mirror.onClose failed", err));
  await publishTradingEvent("PositionClosed", { position_id: position.id, account_id: session.accountId, broker_id: session.brokerId });
  const brokerForActivity = await prisma.broker.findUnique({ where: { id: session.brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } });
  await recordDealerActivity(prisma, {
    brokerId: session.brokerId,
    accountId: session.accountId,
    accountNumber: position.account.accountNumber,
    accountFullName: position.account.fullName,
    isDealingGroup: isDealingManagedAccount({
      group: position.account.group,
      brokerDealingModeOn: !!brokerForActivity?.dealingModeAt,
      dealingDeskAutoFillOn: !!brokerForActivity?.dealingDeskAutoFillAt,
    }),
    action: "POSITION_CLOSED",
    symbol: position.symbol.name,
    side: position.side,
    volume: closeVolume.toString(),
    values: { closePrice, partial: outcome.partial, realizedPnl: outcome.realizedPnl.toString() },
    positionId: position.id,
  });
  return NextResponse.json({ position: outcome.position, transaction: outcome.transaction, partial: outcome.partial });
}
