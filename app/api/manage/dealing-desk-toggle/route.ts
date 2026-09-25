import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { getPermissionContext, PERMISSION_LABELS } from "@/lib/permissions";
import { getFreshPrice } from "@/lib/live-price";
import { openPositionFromOrder } from "@/lib/dealing";
import { resolveWantsDealingQueue } from "@/lib/dealing-routing";
import { resolveBookType, applySpreadMarkup, pipSize } from "@/lib/group-pricing";
import { resolveFillPricing, logSpreadWarning } from "@/lib/pricing-engine";
import { orderAuditFields } from "@/lib/order-audit";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { publishTradingEvent } from "@/lib/nats";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";
import { checkAccountPreTradeMargin } from "@/lib/margin";
import { Prisma } from "@prisma/client";
import { executeQueuedCloseInTx, afterQueuedCloseExecuted } from "@/lib/queued-close";
import {
  checkTradingHalted,
  checkCloseOnly,
  checkSymbolTradingMode,
  checkTradingSession,
  checkLotStep,
  checkGroupMaxLot,
  checkGroupTradingRestriction,
  checkGroupTradingHalted,
  checkGroupCloseOnly,
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
  const permissions = await getPermissionContext(session, "manage/dealing-desk-toggle");
  if (permissions.forbidUnless("RISK_SETTINGS")) {
    return NextResponse.json({ error: "forbidden", permission: "RISK_SETTINGS", permissionLabel: PERMISSION_LABELS.RISK_SETTINGS }, { status: 403 });
  }
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session!.brokerId! } });
  return NextResponse.json({
    dealerOn: broker.dealingDeskAutoFillAt == null,
    dealingDeskAutoFillAt: broker.dealingDeskAutoFillAt ? broker.dealingDeskAutoFillAt.toISOString() : null,
    // auto-hedge (2026-09-23): only acts while the desk is in auto-fill, i.e. while dealerOn is false
    autoHedge: broker.autoHedgeAt != null,
    autoHedgeAt: broker.autoHedgeAt ? broker.autoHedgeAt.toISOString() : null,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await getAdminSession();
  const permissions = await getPermissionContext(session, "manage/dealing-desk-toggle");
  if (permissions.forbidUnless("RISK_SETTINGS")) {
    return NextResponse.json({ error: "forbidden", permission: "RISK_SETTINGS", permissionLabel: PERMISSION_LABELS.RISK_SETTINGS }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const body = await request.json().catch(() => null);
  // Either switch may be sent on its own: {dealerOn} flips manual review, {autoHedge} flips automatic
  // cover. Sending neither is a bad request.
  const hasDealerOn = typeof body?.dealerOn === "boolean";
  const hasAutoHedge = typeof body?.autoHedge === "boolean";
  if (!hasDealerOn && !hasAutoHedge) {
    return NextResponse.json({ error: "dealerOn and/or autoHedge must be a boolean" }, { status: 400 });
  }
  const current = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { dealingDeskAutoFillAt: true } });
  const dealerOn: boolean = hasDealerOn ? body.dealerOn : current.dealingDeskAutoFillAt == null;
  const autoHedge: boolean | null = hasAutoHedge ? body.autoHedge : null;

  const broker = await prisma.$transaction(async (tx) => {
    const updated = await tx.broker.update({
      where: { id: brokerId },
      data: {
        ...(hasDealerOn ? { dealingDeskAutoFillAt: dealerOn ? null : new Date() } : {}),
        ...(autoHedge !== null ? { autoHedgeAt: autoHedge ? new Date() : null } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: autoHedge !== null && !hasDealerOn ? "AUTO_HEDGE_TOGGLED" : "DEALING_DESK_TOGGLED",
        entityType: "Broker",
        entityId: brokerId,
        newValue: { ...(hasDealerOn ? { dealerOn } : {}), ...(autoHedge !== null ? { autoHedge } : {}) },
      },
    });
    return updated;
  });

  // Turning ON needs no flush -- a group going back to requiring manual
  // review doesn't retroactively un-fill anything already auto-filled;
  // only future orders are affected, which the routing check above
  // already handles with zero extra code.
  let flushed: { orderId: string; accountNumber: string; status: "filled" | "skipped"; reason?: string }[] = [];
  if (hasDealerOn && !dealerOn) {
    flushed = await flushDealingQueueToMarket(brokerId, session!.adminId);
  }

  return NextResponse.json({
    dealerOn: broker.dealingDeskAutoFillAt == null,
    dealingDeskAutoFillAt: broker.dealingDeskAutoFillAt ? broker.dealingDeskAutoFillAt.toISOString() : null,
    autoHedge: broker.autoHedgeAt != null,
    autoHedgeAt: broker.autoHedgeAt ? broker.autoHedgeAt.toISOString() : null,
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
  brokerId: string,
  adminId: string
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

    if (order.closesPositionId) {
      // Closes respect DEALER mode: a queued CLOSE the desk no longer wants to review executes at
      // the live close-side price (a BUY position closes at bid) -- "don't leave them stuck"
      // applies to a close exactly as to an open. Only the halt / session gate applies.
      const closeGate = checkTradingHalted(broker) ?? checkTradingSession(brokerSymbol.tradingSessions, new Date(), order.symbol.category);
      if (closeGate) { results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: closeGate }); continue; }
      const closePrice = order.side === "BUY" ? livePrice.bid : livePrice.ask;
      const before = await prisma.position.findUnique({ where: { id: order.closesPositionId }, select: { volume: true } });
      try {
        const result = await prisma.$transaction(async (tx) => {
          const r = await executeQueuedCloseInTx(tx, { order, fromStatus: "PENDING", closePrice, note: "Dealer desk turned off: queued close executed at market" });
          if (r.kind === "closed") {
            await tx.auditLog.create({
              data: {
                brokerId,
                action: "DEALING_DESK_AUTO_FLUSHED_CLOSE",
                entityType: "Position",
                entityId: order.closesPositionId!,
                oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: "PENDING", requestedPrice: order.requestedPrice?.toString() ?? null },
                newValue: { status: "FILLED", closePrice: closePrice.toString(), closeVolume: r.closeVolume.toString(), partial: r.outcome.partial, realizedPnl: r.outcome.realizedPnl.toString(), reason: "dealer_desk_turned_off" },
              },
            });
          }
          return r;
        });
        if (result.kind === "raced") { results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: "already actioned" }); continue; }
        if (result.kind === "position_gone") { results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: "position already closed" }); continue; }
        await afterQueuedCloseExecuted(prisma, {
          brokerId, accountId: order.accountId, accountNumber: order.account.accountNumber, accountFullName: order.account.fullName,
          symbolName: order.symbol.name, side: order.side, positionId: order.closesPositionId, positionVolumeBefore: before?.volume ?? order.volume, result, origin: "dealer_desk_auto_flush",
        });
        results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "filled" });
      } catch (err) {
        console.error("dealing-desk-toggle: auto-flush of a queued close failed", order.id, err);
        results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: "internal error" });
      }
      continue;
    }

    const riskError =
      checkTradingHalted(broker) ??
      checkCloseOnly(broker) ??
      checkSymbolTradingMode(brokerSymbol.tradingMode, order.side) ??
      checkTradingSession(brokerSymbol.tradingSessions, new Date(), order.symbol.category) ??
      checkLotStep(order.volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
      (order.account.group ? checkGroupMaxLot(order.volume, order.account.group.maxLotSize) : null) ??
      (order.account.group ? checkGroupTradingRestriction(order.account.group.tradingRestriction, order.side) : null) ??
      (order.account.group ? checkGroupTradingHalted(order.account.group) : null) ??
      (order.account.group ? checkGroupCloseOnly(order.account.group) : null) ??
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

    const pricing = await resolveFillPricing(prisma, {
      pricingEngineEnabled: broker.pricingEngineEnabled,
      accountId: order.accountId,
      accountTypeId: order.account.accountTypeId,
      groupId: order.account.groupId,
      symbolId: order.symbolId,
      brokerSpreadMarkup: brokerSymbol.spreadMarkup,
      brokerCommissionPerLot: brokerSymbol.commissionPerLot,
      brokerSwapLong: brokerSymbol.swapLong,
      brokerSwapShort: brokerSymbol.swapShort,
      liveBaseSpreadPips: livePrice.ask.sub(livePrice.bid).div(pipSize(brokerSymbol.symbol.digits)),
    });
    logSpreadWarning({ accountId: order.accountId, symbolId: order.symbolId, brokerId }, pricing.warning);
    const liveRef = order.side === "BUY" ? livePrice.ask : livePrice.bid;
    const fillPrice = applySpreadMarkup({ side: order.side, price: liveRef, spreadMarkup: pricing.spreadMarkup, digits: order.symbol.digits });
    // Audit 2026-09-24 (money): the same pre-trade margin gate as a direct fill; an order that fails it is left in
    // the queue (skipped, with the reason), the same as a risk-battery failure above.
    const marginError = await checkAccountPreTradeMargin(prisma, {
      accountId: order.accountId,
      leverage: order.account.leverage,
      marginCallLevel: order.account.group?.marginCallLevel ?? new Prisma.Decimal(100),
      newOrderContractSize: order.symbol.contractSize,
      newOrderQuoteCurrency: order.symbol.quoteCurrency,
      newOrderVolume: order.volume,
      newOrderFillPrice: fillPrice,
      newOrderSide: order.side,
      newOrderSymbolId: order.symbolId,
    });
    if (marginError) {
      results.push({ orderId: order.id, accountNumber: order.account.accountNumber, status: "skipped", reason: marginError.error });
      continue;
    }
    const bookType = resolveBookType(order.account.group.category);

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
      // Audit 2026-09-24 (money): a flushed fill is a fill like any other; with auto-hedge on it is covered the same
      // way (the desk is already in auto-fill here, so the hook applies). Never throws.
      await coverage.onFillAutoHedge(prisma, { positionId: position.id, brokerId, adminId });
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
