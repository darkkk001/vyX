import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { publishTradingEvent } from "@/lib/nats";
import { validatePendingPriceDistance, validateSlTp } from "@/lib/trading";
import { orderAuditFields } from "@/lib/order-audit";

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
    include: { symbol: { select: { name: true } }, account: { select: { accountNumber: true } } },
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
    include: { symbol: { select: { digits: true } } },
  });

  if (requestedPrice !== undefined) {
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
    include: { symbol: { select: { name: true } }, account: { select: { accountNumber: true } } },
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
  return NextResponse.json(cancelled);
}
