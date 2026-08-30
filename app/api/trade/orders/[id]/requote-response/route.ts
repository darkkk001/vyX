import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { openPositionFromOrder } from "@/lib/dealing";
import { resolveBookType, applySpreadMarkup, resolveSymbolPricing } from "@/lib/group-pricing";
import { publishTradingEvent } from "@/lib/nats";
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
} from "@/lib/risk";

// The client's answer to a dealer's requote -- see
// app/api/manage/dealing-queue/[id]/route.ts's ACCEPT branch, which sets
// an order to REQUOTED instead of filling it when the dealer submits a
// price that differs from live. Accept: re-run the same risk checks a
// fresh order submission runs (state may have changed since the dealer
// requoted), then fill at the requoted price. Reject: cancel, no
// Position ever created.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (typeof body?.accept !== "boolean") {
    return NextResponse.json({ error: "accept must be a boolean" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order || order.accountId !== session.accountId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "REQUOTED" || order.requotedPrice == null) {
    return NextResponse.json({ error: "order is not awaiting a requote response" }, { status: 409 });
  }

  if (!body.accept) {
    const updated = await prisma
      .$transaction(async (tx) => {
        const result = await tx.order.updateMany({
          where: { id, status: "REQUOTED" },
          data: { status: "CANCELLED" },
        });
        if (result.count === 0) throw new Error("RACED");
        await tx.auditLog.create({
          data: {
            brokerId: order.brokerId,
            action: "DEALING_ORDER_REQUOTE_REJECTED",
            entityType: "Order",
            entityId: order.id,
            oldValue: { status: "REQUOTED", requotedPrice: order.requotedPrice!.toString() },
            newValue: { status: "CANCELLED" },
          },
        });
        return true;
      })
      .catch((e) => (e instanceof Error && e.message === "RACED" ? null : Promise.reject(e)));
    if (!updated) {
      return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    }
    // Backoffice's "Awaiting client confirmation" list -- see
    // app/manage/(shell)/dealing/DealingQueueManager.tsx -- otherwise has
    // no way to learn the client withdrew/rejected a requote until its
    // next refetch.
    await publishTradingEvent("OrderCancelled", { order_id: id, account_id: session.accountId, broker_id: order.brokerId });
    return NextResponse.json({ id, status: "CANCELLED" });
  }

  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId: order.brokerId, symbolId: order.symbolId, enabled: true },
    include: { tradingSessions: true, symbol: true },
  });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol no longer available for this broker" }, { status: 400 });
  }

  const [broker, account] = await Promise.all([
    prisma.broker.findUniqueOrThrow({ where: { id: order.brokerId } }),
    prisma.account.findUniqueOrThrow({
      where: { id: order.accountId },
      include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } },
    }),
  ]);
  if (account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account is not active" }, { status: 400 });
  }

  const riskError =
    checkTradingHalted(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, order.side) ??
    checkTradingSession(brokerSymbol.tradingSessions, new Date()) ??
    checkLotStep(order.volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
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
    (await checkSymbolExposure(prisma, order.accountId, order.symbolId, order.volume, brokerSymbol.maxExposure)) ??
    (await checkBrokerExposure(prisma, order.brokerId, order.volume, broker.totalExposureLimit)) ??
    (await checkMaxDailyLoss(prisma, order.accountId, account.maxDailyLoss));
  if (riskError) {
    return NextResponse.json({ error: riskError }, { status: 400 });
  }

  // See lib/group-pricing.ts's own comments -- the requoted price was
  // already the dealer's deliberate reprice; markup applies on top of
  // that, same as every other fill site.
  const pricing = await resolveSymbolPricing(prisma, {
    groupId: account.groupId,
    symbolId: order.symbolId,
    brokerSpreadMarkup: brokerSymbol.spreadMarkup,
    brokerCommissionPerLot: brokerSymbol.commissionPerLot,
  });
  const fillPrice = applySpreadMarkup({ side: order.side, price: order.requotedPrice!, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits });
  const bookType = account.group ? resolveBookType(account.group.groupType) : brokerSymbol.defaultBookType;

  try {
    const position = await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id, status: "REQUOTED" },
        data: { status: "ACCEPTED" },
      });
      if (claimed.count === 0) throw new Error("RACED");

      const pos = await openPositionFromOrder(tx, order, fillPrice, bookType, pricing.commissionPerLot);

      await tx.auditLog.create({
        data: {
          brokerId: order.brokerId,
          action: "DEALING_ORDER_REQUOTE_ACCEPTED",
          entityType: "Position",
          entityId: pos.id,
          oldValue: { status: "REQUOTED", requotedPrice: order.requotedPrice!.toString() },
          newValue: { status: "FILLED", filledPrice: fillPrice.toString() },
        },
      });
      return pos;
    });
    await publishTradingEvent("OrderFilled", {
      order_id: order.id,
      account_id: session.accountId,
      broker_id: order.brokerId,
      price: fillPrice.toString(),
      volume: order.volume.toString(),
      remaining_volume: "0",
    });
    return NextResponse.json({ id: order.id, status: "FILLED", positionId: position.id, filledPrice: fillPrice.toString() });
  } catch (error) {
    if (error instanceof Error && error.message === "RACED") {
      return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    }
    throw error;
  }
}
