import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { getPermissionContext } from "@/lib/permissions";
import { getFreshPrice } from "@/lib/live-price";
import { openPositionFromOrder } from "@/lib/dealing";
import { resolveWantsDealingQueue } from "@/lib/dealing-routing";
import { resolveBookType, applySpreadMarkup, resolveSymbolPricing } from "@/lib/group-pricing";
import { orderAuditFields } from "@/lib/order-audit";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { publishTradingEvent } from "@/lib/nats";
import * as mirror from "@/lib/mirror";
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

// Dealer desk ON/OFF (2026-09-04) -- see Broker.dealingDeskAutoFillAt's own
// schema comment for the full semantics/design rationale (a broker-wide
// switch scoped to DEALING-type groups sitting at the dealingMode
// INHERIT default; never touches a group with an explicit MANUAL/AUTO
// override, and is a separate concern from the existing broker-wide
// dealingModeAt "force review even for non-dealing groups" toggle).
// RISK_SETTINGS-gated, same permission this broker's other dealing-
// behavior toggles (Group.dealingMode, Broker.dealingModeAt) already use.
export async function GET() {
  const session = await getAdminSession();
  const permissions = await getPermissionContext(session);
  if (permissions.forbidUnless("RISK_SETTINGS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session!.brokerId! } });
  return NextResponse.json({
    dealerOn: broker.dealingDeskAutoFillAt == null,
    dealingDeskAutoFillAt: broker.dealingDeskAutoFillAt ? broker.dealingDeskAutoFillAt.toISOString() : null,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await getAdminSession();
  const permissions = await getPermissionContext(session);
  if (permissions.forbidUnless("RISK_SETTINGS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const body = await request.json().catch(() => null);
  if (typeof body?.dealerOn !== "boolean") {
    return NextResponse.json({ error: "dealerOn must be a boolean" }, { status: 400 });
  }
  const dealerOn: boolean = body.dealerOn;

  const broker = await prisma.$transaction(async (tx) => {
    const updated = await tx.broker.update({
      where: { id: brokerId },
      data: { dealingDeskAutoFillAt: dealerOn ? null : new Date() },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "DEALING_DESK_TOGGLED",
        entityType: "Broker",
        entityId: brokerId,
        newValue: { dealerOn },
      },
    });
    return updated;
  });

  // Turning ON needs no flush -- a group going back to requiring manual
  // review doesn't retroactively un-fill anything already auto-filled;
  // only future orders are affected, which the routing check above
  // already handles with zero extra code.
  let flushed: { orderId: string; accountNumber: string; status: "filled" | "skipped"; reason?: string }[] = [];
  if (!dealerOn) {
    flushed = await flushDealingQueueToMarket(brokerId);
  }

  return NextResponse.json({
    dealerOn: broker.dealingDeskAutoFillAt == null,
    dealingDeskAutoFillAt: broker.dealingDeskAutoFillAt ? broker.dealingDeskAutoFillAt.toISOString() : null,
    flushed,
  });
}

// Auto-fills, at the current market price, every currently-queued MARKET
// order whose account no longer wants the queue now that the desk is off
// -- "don't leave them stuck waiting" from the feature spec. Re-evaluates
// resolveWantsDealingQueue per order against the NEW broker state rather
// than assuming "everything in the queue" is affected: an order queued
// because its own group is dealingMode=MANUAL (an explicit override this
// switch never touches) correctly stays queued.
//
// Safety-first, not best-effort: an order this can't safely auto-fill
// (no live price, or it would fail the same risk battery Accept runs) is
// left in the queue rather than forced through -- a dealer coming back
// still sees it and can decide by hand. Never fakes a price or bypasses a
// risk check just to clear the queue.
async function flushDealingQueueToMarket(
  brokerId: string
): Promise<{ orderId: string; accountNumber: string; status: "filled" | "skipped"; reason?: string }[]> {
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
  const queued = await prisma.order.findMany({
    where: { brokerId, type: "MARKET", status: "PENDING" },
    include: {
      account: { include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } } },
      symbol: true,
    },
  });

  const results: { orderId: string; accountNumber: string; status: "filled" | "skipped"; reason?: string }[] = [];

  for (const order of queued) {
    const stillWantsQueue = resolveWantsDealingQueue({
      groupDealingMode: order.account.group?.dealingMode ?? "INHERIT",
      brokerDealingModeOn: !!broker.dealingModeAt,
      groupForceDealingMode: !!order.account.group?.forceDealingMode,
      groupTypeIsDealing: order.account.group?.groupType === "DEALING",
      dealingDeskAutoFillOn: !!broker.dealingDeskAutoFillAt,
    });
    if (stillWantsQueue) continue; // explicit MANUAL override or similar -- not this switch's to touch

    const brokerSymbol = await prisma.brokerSymbol.findFirst({
      where: { brokerId, symbolId: order.symbolId, enabled: true },
      include: { tradingSessions: true, symbol: true },
    });
    const livePrice = brokerSymbol ? await getFreshPrice(brokerSymbol.symbol.name) : null;
    if (!brokerSymbol || !livePrice) {
      results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: "no live price" });
      continue;
    }

    const riskError =
      checkTradingHalted(broker) ??
      checkSymbolTradingMode(brokerSymbol.tradingMode, order.side) ??
      checkTradingSession(brokerSymbol.tradingSessions, new Date(), order.symbol.name) ??
      checkLotStep(order.volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
      (order.account.group ? checkGroupMaxLot(order.volume, order.account.group.maxLotSize) : null) ??
      (order.account.group ? checkGroupTradingRestriction(order.account.group.tradingRestriction, order.side) : null) ??
      (order.account.group
        ? checkGroupAllowedSymbol(
            order.account.group.restrictSymbols,
            order.account.group.allowedSymbols.map((s) => s.symbolId),
            order.symbolId
          )
        : null) ??
      (await checkMaxOpenPositions(prisma, order.accountId, broker.maxOpenPositionsPerAccount)) ??
      (await checkSymbolExposure(prisma, order.accountId, order.symbolId, order.volume, brokerSymbol.maxExposure)) ??
      (await checkBrokerExposure(prisma, brokerId, order.volume, broker.totalExposureLimit)) ??
      (await checkMaxDailyLoss(prisma, order.accountId, order.account.maxDailyLoss));
    if (riskError) {
      results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: riskError });
      continue;
    }

    const pricing = await resolveSymbolPricing(prisma, {
      groupId: order.account.groupId,
      symbolId: order.symbolId,
      brokerSpreadMarkup: brokerSymbol.spreadMarkup,
      brokerCommissionPerLot: brokerSymbol.commissionPerLot,
    });
    const liveRef = order.side === "BUY" ? livePrice.ask : livePrice.bid;
    const fillPrice = applySpreadMarkup({ side: order.side, price: liveRef, spreadMarkup: pricing.spreadMarkup, digits: order.symbol.digits });
    const bookType = order.account.group ? resolveBookType(order.account.group.groupType) : brokerSymbol.defaultBookType;

    try {
      const position = await prisma.$transaction(async (tx) => {
        const claimed = await tx.order.updateMany({ where: { id: order.id, status: "PENDING" }, data: { status: "ACCEPTED" } });
        if (claimed.count === 0) throw new Error("RACED");
        const pos = await openPositionFromOrder(tx, order, fillPrice, bookType, pricing.commissionPerLot);
        await tx.auditLog.create({
          data: {
            brokerId,
            action: "DEALING_DESK_AUTO_FLUSHED",
            entityType: "Position",
            entityId: pos.id,
            oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: "PENDING", requestedPrice: order.requestedPrice?.toString() ?? null },
            newValue: { status: "FILLED", filledPrice: fillPrice.toString(), reason: "dealer_desk_turned_off" },
          },
        });
        return pos;
      });
      await mirror.onFillPosition(prisma, position, order.symbol.name).catch((err) => console.error("mirror.onFill failed", err));
      await publishTradingEvent("OrderFilled", {
        order_id: order.id,
        account_id: order.accountId,
        broker_id: brokerId,
        price: fillPrice.toString(),
        volume: order.volume.toString(),
        remaining_volume: "0",
      });
      await recordDealerActivity(prisma, {
        brokerId,
        accountId: order.accountId,
        accountNumber: order.account.accountNumber,
        accountFullName: order.account.fullName,
        isDealingGroup: true, // was in the dealing queue, by definition
        action: "POSITION_OPENED",
        symbol: order.symbol.name,
        side: order.side,
        volume: order.volume.toString(),
        values: { openPrice: fillPrice.toString(), origin: "dealer_desk_auto_flush" },
        orderId: order.id,
        positionId: position.id,
      });
      results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "filled" });
    } catch (err) {
      if (err instanceof Error && err.message === "RACED") {
        results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: "already actioned" });
      } else {
        console.error("dealing-desk-toggle: auto-flush failed for order", order.id, err);
        results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: "internal error" });
      }
    }
  }

  return results;
}
