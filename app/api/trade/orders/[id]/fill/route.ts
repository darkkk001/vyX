import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { publishTradingEvent } from "@/lib/nats";
import { resolveBookType, applySpreadMarkup, resolveSymbolPricing, chargeCommission } from "@/lib/group-pricing";

// Called by the client when its local price simulation reports the
// resting LIMIT/STOP order's trigger price has been hit. Moves the order
// through PENDING -> ACCEPTED -> FILLED and opens the resulting Position,
// atomically. (Phase 5's real engine replaces this trigger-detection with
// server-side matching against a live feed; the state machine itself
// doesn't change.)
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
  const requestedFillPrice = body?.price != null ? String(body.price) : null;
  if (!requestedFillPrice) {
    return NextResponse.json({ error: "price is required" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order || order.accountId !== session.accountId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: `cannot fill an order in status ${order.status}` }, { status: 409 });
  }

  const [brokerSymbol, account, broker] = await Promise.all([
    prisma.brokerSymbol.findFirst({
      where: { brokerId: order.brokerId, symbolId: order.symbolId },
      include: { symbol: true },
    }),
    prisma.account.findUniqueOrThrow({ where: { id: order.accountId }, include: { group: true } }),
    prisma.broker.findUniqueOrThrow({ where: { id: order.brokerId } }),
  ]);

  // Same dealing-mode gate as POST /api/trade/orders' own MARKET-order
  // branch -- a resting LIMIT/STOP order under dealing mode must NOT
  // auto-fill just because its trigger price was hit. Reclassifying to
  // type MARKET (status stays PENDING, requestedPrice becomes the
  // trigger-detected price) is deliberate: it makes this order
  // indistinguishable from a fresh dealing-queue market order, so the
  // existing GET /api/manage/dealing-queue query (type: "MARKET") and
  // the existing PATCH accept/reject route both pick it up with zero
  // changes to either. The client's own pending-order-trigger effect
  // already handles "no position yet" the same way a plain market order
  // under dealing mode does -- nothing to change there either.
  if (broker.dealingModeAt || account.group?.forceDealingMode || account.group?.groupType === "DEALING") {
    const queued = await prisma.order.update({
      where: { id: order.id },
      data: { type: "MARKET", requestedPrice: requestedFillPrice },
    });
    return NextResponse.json({ order: queued, position: null });
  }

  // See lib/group-pricing.ts's own comments -- markup applied to the
  // client's own trigger-detected price (see this route's module doc
  // comment on why the server isn't the price authority for this path
  // yet), not to the reference used to decide the trigger fired.
  const pricing = await resolveSymbolPricing(prisma, {
    groupId: account.groupId,
    symbolId: order.symbolId,
    brokerSpreadMarkup: brokerSymbol?.spreadMarkup ?? new Prisma.Decimal(0),
    brokerCommissionPerLot: brokerSymbol?.commissionPerLot ?? new Prisma.Decimal(0),
  });
  const fillPrice = brokerSymbol
    ? applySpreadMarkup({ side: order.side, price: requestedFillPrice, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits })
    : new Prisma.Decimal(requestedFillPrice);
  const bookType = account.group ? resolveBookType(account.group.groupType) : (brokerSymbol?.defaultBookType ?? "B_BOOK");

  const result = await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: "ACCEPTED" } });
    const filledOrder = await tx.order.update({
      where: { id: order.id },
      data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date() },
    });
    const position = await tx.position.create({
      data: {
        brokerId: order.brokerId,
        accountId: order.accountId,
        symbolId: order.symbolId,
        originOrderId: order.id,
        side: order.side,
        volume: order.volume,
        openPrice: fillPrice,
        slPrice: order.slPrice,
        tpPrice: order.tpPrice,
        bookType,
      },
    });
    await chargeCommission(tx, { brokerId: order.brokerId, accountId: order.accountId, positionId: position.id, commissionPerLot: pricing.commissionPerLot, volume: order.volume });
    return { order: filledOrder, position };
  });

  await publishTradingEvent("OrderFilled", {
    order_id: order.id,
    account_id: order.accountId,
    price: fillPrice.toString(),
    volume: order.volume.toString(),
    remaining_volume: "0",
  });
  return NextResponse.json(result);
}
