import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { publishTradingEvent } from "@/lib/nats";
import { validatePendingPriceDistance, validatePendingOrderDirection, validateSlTp } from "@/lib/trading";
import { orderAuditFields } from "@/lib/order-audit";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { isDealingManagedAccount } from "@/lib/dealing-routing";
import { checkTradingSession, computeNextSessionOpen } from "@/lib/risk";

// Edit a resting PENDING order's own entry price and/or its SL/TP -- the
// chart's draggable entry-price line (LIMIT/STOP only) and, since broker
// feedback item 13, its SL/TP lines too (any PENDING order, including a
// dealing-queued MARKET order still awaiting dealer review -- it hasn't
// filled yet either). Same shape as PATCH /api/trade/positions/[id] but
// for an order that hasn't filled yet -- the one real difference is the
// reference price: a position validates SL/TP against the *current*
// market, an order validates against its *own entry price* (the
// requested/limit/stop price, not a live tick) -- that's the whole
// "stopLevel relative to the entry price" rule item 13 asked for, and
// it's what makes this correct for an order sitting miles from the
// current market on purpose.
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
  const requestedPrice = body?.requestedPrice != null ? String(body.requestedPrice) : undefined;
  const slPrice = body?.slPrice !== undefined ? (body.slPrice == null ? null : String(body.slPrice)) : undefined;
  const tpPrice = body?.tpPrice !== undefined ? (body.tpPrice == null ? null : String(body.tpPrice)) : undefined;

  if (requestedPrice === undefined && slPrice === undefined && tpPrice === undefined) {
    return NextResponse.json({ error: "at least one of requestedPrice, slPrice, or tpPrice is required" }, { status: 400 });
  }
  if (requestedPrice !== undefined && !currentPrice) {
    return NextResponse.json({ error: "currentPrice is required when moving the entry price" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      symbol: { select: { name: true } },
      account: { select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } } },
    },
  });
  if (!order || order.accountId !== session.accountId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: `cannot edit an order in status ${order.status}` }, { status: 409 });
  }
  if (requestedPrice !== undefined && order.type === "MARKET") {
    return NextResponse.json({ error: "MARKET orders have no entry price to edit" }, { status: 400 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId: order.brokerId, symbolId: order.symbolId } },
    include: { symbol: { select: { digits: true } }, tradingSessions: true },
  });

  // Real bug fixed here (2026-09-05 audit finding): this route had NO
  // market-state check at all -- a resting order's entry price or SL/TP
  // could be repriced during a closed market (live-confirmed: a real
  // EURUSD order was successfully modified on a Saturday). Same
  // MARKET_CLOSED + next-open-time answer as place/close/SL-TP-modify.
  const sessionError = checkTradingSession(brokerSymbol?.tradingSessions ?? [], new Date(), order.symbol.name);
  if (sessionError) {
    const nextOpenAt = computeNextSessionOpen(brokerSymbol?.tradingSessions ?? [], new Date());
    return NextResponse.json({ error: sessionError, nextOpenAt: nextOpenAt.toISOString() }, { status: 400 });
  }

  if (requestedPrice !== undefined) {
    // Security/correctness fix (2026-09-05 audit finding), same rule and
    // same reasoning as POST /api/trade/orders' own placement check --
    // moving an order's entry price to the wrong side of the market is
    // just as nonsensical as placing it there in the first place. Uses
    // this route's own fresh server-side LivePrice, not the client-
    // supplied `currentPrice` below (which only ever feeds the stopLevel-
    // distance check) -- the server, never the client, is the price
    // authority for anything that actually rejects a request.
    const livePrice = await prisma.livePrice.findUnique({ where: { symbol: order.symbol.name } });
    if (livePrice) {
      const marketRef = order.side === "BUY" ? livePrice.ask : livePrice.bid;
      const directionError = validatePendingOrderDirection({
        type: order.type as "LIMIT" | "STOP",
        side: order.side,
        entryPrice: requestedPrice,
        marketPrice: marketRef,
      });
      if (directionError) {
        return NextResponse.json({ error: directionError }, { status: 400 });
      }
    }

    const validationError = validatePendingPriceDistance({
      type: order.type as "LIMIT" | "STOP",
      side: order.side,
      entryPrice: requestedPrice,
      marketPrice: currentPrice!,
      digits: brokerSymbol?.symbol.digits ?? 5,
      stopLevel: brokerSymbol?.stopLevel ?? 0,
    });
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
  }

  // Always the order's own entry price, whether it's the one just
  // validated above or the existing one -- an order's SL/TP is never
  // judged against a live tick, only against where it will actually fill.
  const effectiveEntryPrice = requestedPrice ?? order.requestedPrice;
  if ((slPrice !== undefined || tpPrice !== undefined) && effectiveEntryPrice) {
    const slTpError = validateSlTp({
      side: order.side,
      referencePrice: effectiveEntryPrice,
      slPrice: slPrice === undefined ? order.slPrice : slPrice,
      tpPrice: tpPrice === undefined ? order.tpPrice : tpPrice,
      digits: brokerSymbol?.symbol.digits,
      stopLevel: brokerSymbol?.stopLevel,
    });
    if (slTpError) {
      return NextResponse.json({ error: slTpError }, { status: 400 });
    }
  }

  const data: Prisma.OrderUpdateInput = {};
  if (requestedPrice !== undefined) data.requestedPrice = requestedPrice;
  if (slPrice !== undefined) data.slPrice = slPrice;
  if (tpPrice !== undefined) data.tpPrice = tpPrice;

  // Broker feedback items 14+15 -- this route had no audit trail at all
  // before: only whichever of entry/SL/TP actually changed goes into
  // old/new (not the fields left untouched), so a dispute over "the
  // client's SL was moved" shows exactly the before/after value, not a
  // full unrelated snapshot.
  const oldFields: Record<string, unknown> = {};
  const newFields: Record<string, unknown> = {};
  if (requestedPrice !== undefined) {
    oldFields.requestedPrice = order.requestedPrice?.toString() ?? null;
    newFields.requestedPrice = requestedPrice;
  }
  if (slPrice !== undefined) {
    oldFields.slPrice = order.slPrice?.toString() ?? null;
    newFields.slPrice = slPrice;
  }
  if (tpPrice !== undefined) {
    oldFields.tpPrice = order.tpPrice?.toString() ?? null;
    newFields.tpPrice = tpPrice;
  }
  const auditBase = orderAuditFields(order, order.symbol.name, order.account.accountNumber);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.order.update({ where: { id }, data });
    await tx.auditLog.create({
      data: {
        brokerId: order.brokerId,
        action: "ORDER_MODIFIED",
        entityType: "Order",
        entityId: id,
        oldValue: { ...auditBase, ...oldFields },
        newValue: { ...auditBase, ...newFields },
      },
    });
    return result;
  });
  await publishTradingEvent("OrderModified", { order_id: id, account_id: session.accountId, broker_id: session.brokerId });
  const brokerForActivity = await prisma.broker.findUnique({ where: { id: session.brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } });
  await recordDealerActivity(prisma, {
    brokerId: session.brokerId,
    accountId: session.accountId,
    accountNumber: order.account.accountNumber,
    accountFullName: order.account.fullName,
    isDealingGroup: isDealingManagedAccount({
      group: order.account.group,
      brokerDealingModeOn: !!brokerForActivity?.dealingModeAt,
      dealingDeskAutoFillOn: !!brokerForActivity?.dealingDeskAutoFillAt,
    }),
    action: "ORDER_MODIFIED",
    symbol: order.symbol.name,
    side: order.side,
    volume: order.volume.toString(),
    values: {
      oldRequestedPrice: oldFields.requestedPrice ?? undefined,
      newRequestedPrice: newFields.requestedPrice ?? undefined,
      oldSlPrice: oldFields.slPrice ?? undefined,
      newSlPrice: newFields.slPrice ?? undefined,
      oldTpPrice: oldFields.tpPrice ?? undefined,
      newTpPrice: newFields.tpPrice ?? undefined,
    },
    orderId: id,
  });
  return NextResponse.json(updated);
}

// Cancel a resting PENDING order. No arbitrary status jumps — only
// PENDING -> CANCELLED is allowed here.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      symbol: { select: { name: true } },
      account: { select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } } },
    },
  });
  if (!order || order.accountId !== session.accountId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: `cannot cancel an order in status ${order.status}` }, { status: 409 });
  }

  const cancelled = await prisma.order.update({
    where: { id },
    data: { status: "CANCELLED" },
  });
  // Queued-order UX -- a trader withdrawing a dealing-group MARKET order
  // before the desk reviews it is a real, money-relevant action (the
  // dealer might already be looking at it) that had no audit trail at
  // all before this: order creation (this same route's POST) already
  // wrote an AuditLog row, cancellation never did. actorAdminId is null
  // here on purpose -- this is the trader's own action, not staff's; the
  // same AuditLog row shape backoffice-initiated cancellations would use
  // just carries an actorAdminId instead.
  //
  // Broker feedback items 14+15 -- "cancel time + who" was the specific
  // ask; cancelledAt is stamped explicitly (rather than relying on the
  // row's own createdAt) so it survives even if this AuditLog write ever
  // gets delayed relative to the actual cancellation, and cancelledBy
  // makes "the client cancelled it, not a dealer" answerable without
  // having to know that a null actorAdminId means that.
  await prisma.auditLog.create({
    data: {
      brokerId: order.brokerId,
      action: order.type === "MARKET" ? "TRADER_CANCELLED_DEALING_ORDER" : "TRADER_CANCELLED_PENDING_ORDER",
      entityType: "Order",
      entityId: id,
      oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: order.status },
      newValue: { status: "CANCELLED", cancelledBy: "CLIENT", cancelledAt: new Date().toISOString() },
    },
  });
  await publishTradingEvent("OrderCancelled", { order_id: id, account_id: session.accountId, broker_id: session.brokerId });
  const brokerForActivity = await prisma.broker.findUnique({ where: { id: session.brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } });
  await recordDealerActivity(prisma, {
    brokerId: session.brokerId,
    accountId: session.accountId,
    accountNumber: order.account.accountNumber,
    accountFullName: order.account.fullName,
    isDealingGroup: isDealingManagedAccount({
      group: order.account.group,
      brokerDealingModeOn: !!brokerForActivity?.dealingModeAt,
      dealingDeskAutoFillOn: !!brokerForActivity?.dealingDeskAutoFillAt,
    }),
    action: "ORDER_CANCELLED",
    symbol: order.symbol.name,
    side: order.side,
    volume: order.volume.toString(),
    values: { requestedPrice: order.requestedPrice?.toString() ?? null, cancelledBy: "CLIENT" },
    orderId: id,
  });
  return NextResponse.json(cancelled);
}
