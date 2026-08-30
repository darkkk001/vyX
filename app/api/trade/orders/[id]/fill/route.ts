import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { publishTradingEvent } from "@/lib/nats";
import { createNotification } from "@/lib/notifications";
import { resolveBookType, applySpreadMarkup, resolveSymbolPricing, chargeCommission } from "@/lib/group-pricing";
import {
  checkTradingHalted,
  checkSymbolTradingMode,
  checkTradingSession,
  checkLotStep,
  checkGroupMaxLot,
  checkGroupTradingRestriction,
  checkGroupAllowedSymbol,
  checkMaxOpenPositions,
  checkSymbolExposure,
  checkBrokerExposure,
  checkMaxDailyLoss,
  checkLiveMarketPrice,
} from "@/lib/risk";

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
      include: { symbol: true, tradingSessions: true },
    }),
    prisma.account.findUniqueOrThrow({
      where: { id: order.accountId },
      include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } },
    }),
    prisma.broker.findUniqueOrThrow({ where: { id: order.brokerId } }),
  ]);

  // Same risk battery POST /api/trade/orders and the dealing-queue Accept
  // route both run before opening a position -- this fill path (a
  // pending order's trigger firing, possibly days after submission) was
  // the one place none of this ran at all: a resting order could fill
  // straight through an exposure limit or a broker-wide trading halt
  // declared after it was placed. checkTradingHalted first since it's
  // the one that matters most for something that can trigger while
  // nobody's watching.
  const riskError =
    checkTradingHalted(broker) ??
    (brokerSymbol ? checkSymbolTradingMode(brokerSymbol.tradingMode, order.side) : null) ??
    (brokerSymbol ? checkTradingSession(brokerSymbol.tradingSessions, new Date()) : null) ??
    (brokerSymbol ? checkLotStep(order.volume, brokerSymbol.minLot, brokerSymbol.lotStep) : null) ??
    (brokerSymbol ? await checkLiveMarketPrice(prisma, brokerSymbol.symbol.name, requestedFillPrice) : null) ??
    (account.group ? checkGroupMaxLot(order.volume, account.group.maxLotSize) : null) ??
    (account.group ? checkGroupTradingRestriction(account.group.tradingRestriction, order.side) : null) ??
    (account.group
      ? checkGroupAllowedSymbol(
          account.group.restrictSymbols,
          account.group.allowedSymbols.map((s) => s.symbolId),
          order.symbolId
        )
      : null) ??
    (await checkMaxOpenPositions(prisma, order.accountId, broker.maxOpenPositionsPerAccount)) ??
    (await checkSymbolExposure(prisma, order.accountId, order.symbolId, order.volume, brokerSymbol?.maxExposure ?? null)) ??
    (await checkBrokerExposure(prisma, order.brokerId, order.volume, broker.totalExposureLimit)) ??
    (await checkMaxDailyLoss(prisma, order.accountId, account.maxDailyLoss));
  if (riskError) {
    return NextResponse.json({ error: riskError }, { status: 400 });
  }

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
    const originalType = order.type;
    const originalRequestedPrice = order.requestedPrice?.toString() ?? null;
    const queued = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { type: "MARKET", requestedPrice: requestedFillPrice },
      });
      // The order's own original type/price get overwritten above (kept
      // out of a new column deliberately -- see this branch's own doc
      // comment on why reclassifying in place, not adding new schema, was
      // the choice) -- this audit row is the only place that history
      // survives. Previously nothing recorded this ever happened at all.
      await tx.auditLog.create({
        data: {
          brokerId: order.brokerId,
          action: "PENDING_ORDER_QUEUED_FOR_DEALING",
          entityType: "Order",
          entityId: order.id,
          oldValue: { type: originalType, requestedPrice: originalRequestedPrice, status: "PENDING" },
          newValue: { type: "MARKET", requestedPrice: requestedFillPrice, status: "PENDING" },
        },
      });
      return updated;
    });
    // Same notification a fresh dealing-queue market order gets
    // (app/api/trade/orders/route.ts) -- previously a triggered pending
    // order queued completely silently, with no badge/alert telling a
    // dealer it was waiting.
    await createNotification(prisma, {
      brokerId: order.brokerId,
      type: "DEALING_ORDER_PENDING",
      title: "Order awaiting dealer review",
      body: `${account.accountNumber} — ${order.side} ${order.volume.toString()} ${brokerSymbol?.symbol.name ?? ""} (triggered pending order)`,
      entityType: "Order",
      entityId: order.id,
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
    broker_id: order.brokerId,
    price: fillPrice.toString(),
    volume: order.volume.toString(),
    remaining_volume: "0",
  });
  return NextResponse.json(result);
}
