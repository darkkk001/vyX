import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { publishTradingEvent } from "@/lib/nats";
import { validatePendingPriceDistance } from "@/lib/trading";

// Edit a resting PENDING order's own entry price (and/or its SL/TP) --
// the chart's draggable entry-price line for LIMIT/STOP orders, same
// shape as PATCH /api/trade/positions/[id] but for an order that hasn't
// filled yet. `currentPrice` is the client's own live price, same
// client-reported-reference-price pattern used everywhere else in this
// file (order creation never validated a LIMIT/STOP's side against the
// market either -- see the comment on the POST handler -- so this only
// adds the new stopLevel minimum-distance check, nothing stricter).
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

  if (!currentPrice) {
    return NextResponse.json({ error: "currentPrice is required" }, { status: 400 });
  }
  if (requestedPrice === undefined) {
    return NextResponse.json({ error: "requestedPrice is required" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order || order.accountId !== session.accountId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: `cannot edit an order in status ${order.status}` }, { status: 409 });
  }
  if (order.type === "MARKET") {
    return NextResponse.json({ error: "MARKET orders have no entry price to edit" }, { status: 400 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId: order.brokerId, symbolId: order.symbolId } },
    include: { symbol: { select: { digits: true } } },
  });

  const validationError = validatePendingPriceDistance({
    type: order.type,
    side: order.side,
    entryPrice: requestedPrice,
    marketPrice: currentPrice,
    digits: brokerSymbol?.symbol.digits ?? 5,
    stopLevel: brokerSymbol?.stopLevel ?? 0,
  });
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const updated = await prisma.order.update({
    where: { id },
    data: { requestedPrice },
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

  const order = await prisma.order.findUnique({ where: { id } });
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
  await prisma.auditLog.create({
    data: {
      brokerId: order.brokerId,
      action: order.type === "MARKET" ? "TRADER_CANCELLED_DEALING_ORDER" : "TRADER_CANCELLED_PENDING_ORDER",
      entityType: "Order",
      entityId: id,
      oldValue: { status: order.status },
      newValue: { status: "CANCELLED" },
    },
  });
  await publishTradingEvent("OrderCancelled", { order_id: id, account_id: session.accountId, broker_id: session.brokerId });
  return NextResponse.json(cancelled);
}
