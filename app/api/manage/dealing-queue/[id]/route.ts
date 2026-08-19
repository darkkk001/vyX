import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import {
  checkTradingHalted,
  checkSymbolTradingMode,
  checkLotStep,
  checkMaxOpenPositions,
  checkSymbolExposure,
  checkBrokerExposure,
  checkMaxDailyLoss,
} from "@/lib/risk";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Accept (fill, optionally at a dealer-requoted price) or Reject a
// dealing-queue order -- see app/api/trade/orders/route.ts's
// dealingModeAt branch and app/api/manage/dealing-queue/route.ts (GET).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const action = body?.action === "ACCEPT" ? "ACCEPT" : body?.action === "REJECT" ? "REJECT" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be ACCEPT or REJECT" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id },
    include: { account: true, symbol: true },
  });
  if (!order || order.brokerId !== brokerId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.type !== "MARKET" || order.status !== "PENDING") {
    return NextResponse.json({ error: "order is not awaiting dealer review" }, { status: 409 });
  }

  if (action === "REJECT") {
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return NextResponse.json({ error: "reason is required for the audit trail" }, { status: 400 });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id, status: "PENDING" }, // race guard -- see the note on ACCEPT's transaction below
        data: { status: "REJECTED", rejectionReason: reason },
      });
      if (result.count === 0) throw new Error("RACED");
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "DEALING_ORDER_REJECTED",
          entityType: "Order",
          entityId: id,
          oldValue: { status: "PENDING" },
          newValue: { status: "REJECTED", reason },
        },
      });
      return true;
    }).catch((e) => (e instanceof Error && e.message === "RACED" ? null : Promise.reject(e)));
    if (!updated) {
      return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    }
    return NextResponse.json({ id, status: "REJECTED" });
  }

  // ACCEPT
  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId, symbolId: order.symbolId, enabled: true },
  });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol no longer available for this broker" }, { status: 400 });
  }
  if (order.account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account is not active" }, { status: 400 });
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
  // State may have changed since the trader submitted -- re-run the same
  // checks a manual position open runs (app/api/manage/positions/route.ts).
  const riskError =
    checkTradingHalted(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, order.side) ??
    checkLotStep(order.volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
    (await checkMaxOpenPositions(prisma, order.accountId, broker.maxOpenPositionsPerAccount)) ??
    (await checkSymbolExposure(prisma, order.accountId, order.symbolId, order.volume, brokerSymbol.maxExposure)) ??
    (await checkBrokerExposure(prisma, brokerId, order.volume, broker.totalExposureLimit)) ??
    (await checkMaxDailyLoss(prisma, order.accountId, order.account.maxDailyLoss));
  if (riskError) {
    return NextResponse.json({ error: riskError }, { status: 400 });
  }

  let fillPrice: Prisma.Decimal;
  let requoted = false;
  if (body?.price != null) {
    try {
      fillPrice = new Prisma.Decimal(String(body.price));
    } catch {
      return NextResponse.json({ error: "invalid price" }, { status: 400 });
    }
    if (fillPrice.lte(0)) {
      return NextResponse.json({ error: "price must be positive" }, { status: 400 });
    }
    requoted = order.requestedPrice == null || !fillPrice.equals(order.requestedPrice);
  } else {
    const live = await getFreshPrice(order.symbol.name);
    if (!live) {
      return NextResponse.json({ error: `no live price for ${order.symbol.name} -- supply a price to requote manually` }, { status: 409 });
    }
    fillPrice = order.side === "BUY" ? live.ask : live.bid;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const filled = await tx.order.updateMany({
        where: { id, status: "PENDING" }, // race guard: another dealer/tab acting on the same order concurrently
        data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date() },
      });
      if (filled.count === 0) throw new Error("RACED");

      const position = await tx.position.create({
        data: {
          brokerId,
          accountId: order.accountId,
          symbolId: order.symbolId,
          originOrderId: order.id,
          side: order.side,
          volume: order.volume,
          openPrice: fillPrice,
          slPrice: order.slPrice,
          tpPrice: order.tpPrice,
        },
      });

      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "DEALING_ORDER_ACCEPTED",
          entityType: "Position",
          entityId: position.id,
          oldValue: { status: "PENDING", requestedPrice: order.requestedPrice?.toString() ?? null },
          newValue: { status: "FILLED", filledPrice: fillPrice.toString(), requoted },
        },
      });

      return position;
    });
    return NextResponse.json({ id: order.id, status: "FILLED", positionId: result.id, filledPrice: fillPrice.toString() });
  } catch (error) {
    if (error instanceof Error && error.message === "RACED") {
      return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    }
    throw error;
  }
}
