import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { checkTradingSession, computeNextSessionOpen } from "@/lib/risk";
import { executeAdminCloseInTx } from "@/lib/position-actions";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { cancelPendingClose } from "@/lib/queued-close";
import { isDealingManagedAccount } from "@/lib/dealing-routing";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Manual (admin-initiated) position close -- mirrors
// app/api/trade/positions/[id]/close/route.ts's balance/Transaction
// shape exactly (read balance inside the transaction, compute
// balanceAfter, explicit `data: { balance: balanceAfter }` rather than
// `increment`, same TRADE_PNL Transaction row), scoped by brokerId
// instead of the trader route's accountId-ownership check since an
// admin acts on any account under their own broker. First real usage of
// Position.closedByAdminId and the "MANUAL_POSITION_CLOSE" AuditLog
// action -- both existed in the schema/doc comments already but nothing
// wrote them until now. Price comes from LivePrice (confirmed with the
// user), not an admin-typed value.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const position = await prisma.position.findUnique({
    where: { id },
    include: {
      symbol: { select: { name: true, category: true, contractSize: true } },
      account: { select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } } },
    },
  });
  if (!position || position.brokerId !== brokerId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }

  // 2026-09-06 Section E audit fix -- this route relied entirely on
  // getFreshPrice's 15s staleness window as a proxy for "market closed,"
  // unlike every trader-facing close/modify path (all fixed 2026-09-05),
  // which check the real session directly. Not currently exploitable in
  // practice (tickAt genuinely stops advancing within seconds of a real
  // market closing), but inconsistent -- an admin closing during a real
  // closed market got a confusing "no live price" instead of the same
  // "Market closed, opens..." answer every other path now gives, and a
  // broker configuring a real TradingSession window narrower than when
  // the raw feed itself goes quiet would have let this proceed when it
  // shouldn't.
  const brokerSymbol = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId, symbolId: position.symbolId } },
    include: { tradingSessions: true },
  });
  const sessionError = checkTradingSession(brokerSymbol?.tradingSessions ?? [], new Date(), position.symbol.category);
  if (sessionError) {
    const nextOpenAt = computeNextSessionOpen(brokerSymbol?.tradingSessions ?? [], new Date(), position.symbol.category);
    return NextResponse.json({ error: sessionError, nextOpenAt: nextOpenAt.toISOString() }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
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
    closeVolume = requested;
  }
  const isPartial = closeVolume.lt(position.volume);

  const price = await getFreshPrice(position.symbol.name);
  if (!price) {
    return NextResponse.json({ error: `no live price for ${position.symbol.name}` }, { status: 409 });
  }
  // Same close-price convention as calc::close_price_for (Rust engine)
  // and this session's positions dashboard: bid for an open BUY, ask
  // for an open SELL -- what closing it right now would actually fill at.
  const closePrice = position.side === "BUY" ? price.bid : price.ask;

  // The close itself is lib/position-actions.ts executeAdminCloseInTx -> closePositionInTx (2026-09-23):
  // status + volume guard against a double close, negative-balance protection, the TRADE_PNL row, the
  // closing admin and the MANUAL_POSITION_CLOSE audit, all in one transaction.
  const result = await prisma.$transaction((tx) =>
    executeAdminCloseInTx(tx, { brokerId, adminId: session.adminId, position, closePrice, closeVolume })
  );
  if (!result.closed) {
    return NextResponse.json({ error: "position was closed or changed by another action, refresh and try again" }, { status: 409 });
  }
  const realizedPnl = result.realizedPnl;

  // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- mirror hook gap fix: a
  // dealer-initiated close is a real close, same as the trader's own
  // self-close route. `position.volume` here is still this route's own
  // top-of-function read, from before the transaction closed/reduced it.
  await mirror.onClose(prisma, {
    positionId: position.id,
    brokerId,
    closedLots: closeVolume,
    sourceVolumeBeforeClose: position.volume,
    closePrice,
  }).catch((err) => console.error("mirror.onClose failed", err));
  // coverage follow-through (lib/coverage.ts onClose): a client leg closes its hedge; a hedge leg
  // closed by hand releases the client position back to the Smart Dealer Manager
  await coverage.onClose(prisma, { positionId: position.id, brokerId, closedLots: closeVolume, sourceVolumeBeforeClose: position.volume, reason: "manual" }).catch((err) => console.error("coverage.onClose failed", err));
  // Realtime-sync gap fix -- this route never published a live event at
  // all before, on top of lib/nats.ts's own (separately fixed) transport
  // bug. Without it, a dealer-initiated close never appeared on the
  // backoffice Positions/Exposure views until a manual refresh.
  // Closes respect DEALER mode: an admin's manual close bypasses the queue; a close the client had
  // queued for this position is moot once it is fully closed (a partial keeps it, and its lock).
  if (!isPartial) await cancelPendingClose(prisma, position.id, "position closed by admin").catch((err) => console.error("cancelPendingClose failed", err));
  await publishTradingEvent("PositionClosed", { position_id: position.id, account_id: position.accountId, broker_id: brokerId });
  const brokerForActivity = await prisma.broker.findUnique({ where: { id: brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } });
  await recordDealerActivity(prisma, {
    brokerId,
    accountId: position.accountId,
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
    values: { closePrice: closePrice.toString(), partial: isPartial, realizedPnl: realizedPnl.toString(), origin: "admin_manual_close" },
    positionId: position.id,
  });

  return NextResponse.json({
    positionId: position.id,
    partial: result.partial,
    closePrice: closePrice.toString(),
    realizedPnl: realizedPnl.toString(),
  });
}
