import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { openPositionFromOrder } from "@/lib/dealing";
import { orderAuditFields } from "@/lib/order-audit";
import { resolveBookType, applySpreadMarkup } from "@/lib/group-pricing";
import { resolveFillPricing, logSpreadWarning } from "@/lib/pricing-engine";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { isDealingManagedAccount } from "@/lib/dealing-routing";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";
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
  checkGroupAllowedSymbol,
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

// Accept, Requote, or Reject a dealing-queue order -- see
// app/api/trade/orders/route.ts's dealingModeAt branch and
// app/api/manage/dealing-queue/route.ts (GET).
//
// ACCEPT fills at exactly the client's own requested price -- no live-
// price comparison, no automatic requote. The dealer is consciously
// taking that price; the client's own request was already validated
// against live ± max deviation at submission time (Phase 0 money-risk
// patch), so a stale/abusive price never reaches the queue in the first
// place. This replaced an earlier design where ACCEPT silently became a
// REQUOTE the instant the (often several-seconds-stale, since the
// queue's own live price is a snapshot, not push-updated) accept price
// didn't match a freshly-refetched live price -- in production this
// requoted essentially every single order, since gold moves within any
// real human reaction time. REQUOTE is now its own explicit action.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const action = body?.action === "ACCEPT" ? "ACCEPT" : body?.action === "REQUOTE" ? "REQUOTE" : body?.action === "REJECT" ? "REJECT" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be ACCEPT, REQUOTE, or REJECT" }, { status: 400 });
  }
  // ACCEPT fill basis: "REQUESTED" (default -- fill at exactly the client's
  // requested price, this route's original behavior) or "MARKET" (fill at
  // the current live price, the dealer's "accept at market" option). Ignored
  // for REQUOTE/REJECT. Backward-compatible: an older client that sends no
  // fillMode gets REQUESTED, unchanged.
  const fillMode = body?.fillMode === "MARKET" ? "MARKET" : "REQUESTED";

  const order = await prisma.order.findUnique({
    where: { id },
    include: { account: { include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } } }, symbol: true, closesPosition: { select: { id: true, ticket: true, volume: true, status: true } } },
  });
  if (!order || order.brokerId !== brokerId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.type !== "MARKET" || (order.status !== "PENDING" && order.status !== "REQUOTED")) {
    return NextResponse.json({ error: "order is not awaiting dealer review" }, { status: 409 });
  }

  // Requested + live at click time, for every action's audit row -- so
  // "why did the dealer do this" is always answerable later without
  // needing to reconstruct the live price separately. Best-effort only:
  // a live price is never required to REJECT or (for the reasons in this
  // route's own module comment) to ACCEPT.
  const liveAtClick = await getFreshPrice(order.symbol.name);
  // an OPEN fills at ask (BUY) / bid (SELL); a queued CLOSE (closesPositionId set, docs/CLOSES-
  // RESPECT-DEALER-MODE.md) settles on the other side: a BUY position closes at bid, a SELL at ask
  const isClose = order.closesPositionId != null;
  const liveRefAtClick = liveAtClick ? ((order.side === "BUY") !== isClose ? liveAtClick.ask : liveAtClick.bid) : null;

  if (action === "REJECT") {
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return NextResponse.json({ error: "reason is required for the audit trail" }, { status: 400 });
    }
    const priorStatus = order.status; // PENDING (reject a fresh order) or REQUOTED (withdraw an unanswered requote)
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id, status: priorStatus }, // race guard -- see the note on ACCEPT's transaction below
        data: { status: "REJECTED", rejectionReason: reason },
      });
      if (result.count === 0) throw new Error("RACED");
      // a rejected CLOSE leaves the position open and unlocked
      if (order.closesPositionId) await tx.position.updateMany({ where: { id: order.closesPositionId, closePendingOrderId: id }, data: { closePendingOrderId: null } });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: isClose ? "DEALING_CLOSE_REJECTED" : "DEALING_ORDER_REJECTED",
          entityType: "Order",
          entityId: id,
          oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: priorStatus, requestedPrice: order.requestedPrice?.toString() ?? null },
          newValue: {
            status: "REJECTED",
            reason,
            cancelledBy: "DEALER",
            liveAtClick: liveRefAtClick?.toString() ?? null,
          },
        },
      });
      return true;
    }).catch((e) => (e instanceof Error && e.message === "RACED" ? null : Promise.reject(e)));
    if (!updated) {
      return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    }
    // Trader's own WebTrader (account_id) and every other backoffice tab
    // watching this broker (broker_id) both need this -- neither
    // previously learned about a dealing-queue reject until their next
    // poll/refresh.
    await publishTradingEvent("OrderRejected", { order_id: id, account_id: order.accountId, broker_id: brokerId, reason });
    return NextResponse.json({ id, status: "REJECTED" });
  }

  // ACCEPT/REQUOTE -- only valid on a fresh PENDING order. A REQUOTED
  // order is already awaiting the *client's* answer; the dealer can only
  // withdraw it (REJECT above), not accept/requote it again.
  if (order.status === "REQUOTED") {
    return NextResponse.json(
      { error: "this order was already requoted, it can only be withdrawn (Reject) until the client responds" },
      { status: 409 }
    );
  }

  if (action === "REQUOTE") {
    let requotedPrice: Prisma.Decimal;
    try {
      requotedPrice = new Prisma.Decimal(String(body?.price ?? ""));
    } catch {
      return NextResponse.json({ error: "invalid price" }, { status: 400 });
    }
    if (requotedPrice.lte(0)) {
      return NextResponse.json({ error: "price must be positive" }, { status: 400 });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "REQUOTED", requotedPrice },
      });
      if (result.count === 0) throw new Error("RACED");
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: isClose ? "DEALING_CLOSE_REQUOTED" : "DEALING_ORDER_REQUOTED",
          entityType: "Order",
          entityId: id,
          oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: "PENDING", requestedPrice: order.requestedPrice?.toString() ?? null },
          newValue: { status: "REQUOTED", requotedPrice: requotedPrice.toString(), liveAtClick: liveRefAtClick?.toString() ?? null },
        },
      });
      return true;
    }).catch((e) => (e instanceof Error && e.message === "RACED" ? null : Promise.reject(e)));
    if (!updated) {
      return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    }
    await publishTradingEvent("OrderRequoted", {
      order_id: id,
      account_id: order.accountId,
      broker_id: brokerId,
      requoted_price: requotedPrice.toString(),
    });
    return NextResponse.json({ id, status: "REQUOTED", requotedPrice: requotedPrice.toString() });
  }

  // ACCEPT -- fills at exactly order.requestedPrice (see this route's own
  // module comment for why: no live-price comparison, no automatic
  // requote). Every other check below is unrelated to price and still
  // applies -- state (symbol enabled, account active, risk battery) can
  // have changed since the trader submitted, regardless of what price is
  // being filled at.
  if (order.requestedPrice == null) {
    // Defensive only -- every MARKET order that reaches the dealing
    // queue has a requestedPrice stamped at submission time
    // (app/api/trade/orders/route.ts); this schema also allows null for
    // the *direct*-fill (non-queued) path, which never reaches here.
    return NextResponse.json({ error: "order has no requested price to accept at" }, { status: 409 });
  }
  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId, symbolId: order.symbolId, enabled: true },
    include: { tradingSessions: true },
  });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol no longer available for this broker" }, { status: 400 });
  }
  if (order.account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account is not active" }, { status: 400 });
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });

  if (isClose) {
    // ACCEPT on a queued CLOSE: close the position at the dealer's price -- the client's own
    // requested close price (REQUESTED) or the live close-side price at click (MARKET) -- with no
    // spread markup (a close realizes at the price, the way every other close path does). The
    // open-side risk battery (max positions, exposure, lot rules) does not apply to a close; the
    // market must be open and trading not halted for this broker. Close-only mode allows closes.
    const closeRiskError = checkTradingHalted(broker) ?? checkTradingSession(brokerSymbol.tradingSessions, new Date(), order.symbol.category);
    if (closeRiskError) {
      return NextResponse.json({ error: closeRiskError }, { status: 400 });
    }
    const closePrice = fillMode === "MARKET" ? liveRefAtClick : order.requestedPrice;
    if (closePrice == null) {
      return NextResponse.json({ error: "no live price available to close at market" }, { status: 409 });
    }
    const positionVolumeBefore = order.closesPosition?.volume ?? order.volume;
    const result = await prisma.$transaction(async (tx) => {
      const r = await executeQueuedCloseInTx(tx, { order, fromStatus: "PENDING", closePrice, note: `Dealer close (${fillMode === "MARKET" ? "at market" : "at requested price"})` });
      if (r.kind === "closed") {
        await tx.auditLog.create({
          data: {
            brokerId,
            actorAdminId: session.adminId,
            action: "DEALING_CLOSE_ACCEPTED",
            entityType: "Position",
            entityId: order.closesPositionId!,
            oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: "PENDING", requestedPrice: order.requestedPrice?.toString() ?? null, closesTicket: order.closesPosition?.ticket ?? null },
            newValue: { status: "FILLED", fillMode, closePrice: closePrice.toString(), closeVolume: r.closeVolume.toString(), partial: r.outcome.partial, realizedPnl: r.outcome.realizedPnl.toString(), liveAtClick: liveRefAtClick?.toString() ?? null },
          },
        });
      }
      return r;
    });
    if (result.kind === "raced") return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    if (result.kind === "position_gone") {
      await publishTradingEvent("OrderCancelled", { order_id: order.id, account_id: order.accountId, broker_id: brokerId, reason: "position already closed" });
      return NextResponse.json({ error: "position was already closed (by SL / TP / stop-out or another close); the close request is cancelled" }, { status: 409 });
    }
    await afterQueuedCloseExecuted(prisma, {
      brokerId,
      accountId: order.accountId,
      accountNumber: order.account.accountNumber,
      accountFullName: order.account.fullName,
      symbolName: order.symbol.name,
      side: order.side,
      positionId: order.closesPositionId!,
      positionVolumeBefore,
      result,
      origin: "dealer_accept",
    });
    return NextResponse.json({ id: order.id, status: "FILLED", positionId: order.closesPositionId, closed: true, partial: result.outcome.partial, closePrice: closePrice.toString(), realizedPnl: result.outcome.realizedPnl.toString() });
  }
  // State may have changed since the trader submitted -- re-run the same
  // checks a manual position open runs (app/api/manage/positions/route.ts).
  const riskError =
    checkTradingHalted(broker) ??
    checkCloseOnly(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, order.side) ??
    checkTradingSession(brokerSymbol.tradingSessions, new Date(), order.symbol.category) ??
    checkLotStep(order.volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
    (order.account.group ? checkGroupMaxLot(order.volume, order.account.group.maxLotSize) : null) ??
    (order.account.group ? checkGroupTradingRestriction(order.account.group.tradingRestriction, order.side) : null) ??
    (order.account.group ? checkGroupTradingHalted(order.account.group) : null) ??
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
    return NextResponse.json({ error: riskError }, { status: 400 });
  }

  // See lib/group-pricing.ts's own comments -- markup applied on top of
  // the client's own requested price, same as every other fill site.
  // No live tick basis here -- ACCEPT fills at exactly the order's own
  // requestedPrice (see this branch's own comment above), so
  // liveBaseSpreadPips is null (Q1: a target-spread level falls back to
  // its own configured markup, never blocks the accept).
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
    liveBaseSpreadPips: null,
  });
  logSpreadWarning({ accountId: order.accountId, symbolId: order.symbolId, brokerId }, pricing.warning);
  // REQUESTED = the client's own price (requestedPrice, guarded non-null above);
  // MARKET = the live price this route already read at click (liveRefAtClick,
  // side-correct: ask for BUY, bid for SELL). Broker spread markup then applies
  // on top of whichever base, same as every other fill site.
  const acceptBase = fillMode === "MARKET" ? liveRefAtClick : order.requestedPrice;
  if (acceptBase == null) {
    return NextResponse.json({ error: "no live price available to accept at market" }, { status: 409 });
  }
  const markedUpFillPrice = applySpreadMarkup({ side: order.side, price: acceptBase, spreadMarkup: pricing.spreadMarkup, digits: order.symbol.digits });
  const bookType = resolveBookType(order.account.group.category);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id, status: "PENDING" }, // race guard: another dealer/tab acting on the same order concurrently
        data: { status: "ACCEPTED" },
      });
      if (claimed.count === 0) throw new Error("RACED");

      const position = await openPositionFromOrder(tx, order, markedUpFillPrice, bookType, pricing.commissionPerLot);

      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "DEALING_ORDER_ACCEPTED",
          entityType: "Position",
          entityId: position.id,
          oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: "PENDING", requestedPrice: order.requestedPrice?.toString() ?? null },
          newValue: { status: "FILLED", fillMode, filledPrice: markedUpFillPrice.toString(), acceptBase: acceptBase.toString(), liveAtClick: liveRefAtClick?.toString() ?? null },
        },
      });

      return position;
    });
    // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- mirror hook gap fix: a dealer
    // ACCEPT is a real fill, the same as any other fill path, but this
    // route never called mirror.onFill at all until now.
    await mirror.onFillPosition(prisma, result, order.symbol.name).catch((err) => console.error("mirror.onFill failed", err));
    // auto-hedge (lib/coverage.ts): a no-op unless the desk is in auto-fill with auto-hedge on
    await coverage.onFillAutoHedge(prisma, { positionId: result.id, brokerId: brokerId });
    // See this route's own new import comment -- the trader's own
    // WebTrader is listening on account_id already (components/webtrader/
    // WebTrader.tsx's /v1/trading/stream effect); broker_id is what makes
    // this also reach every other backoffice tab
    // (services/api-gateway/src/ws.ts's attachAdminEventStream).
    await publishTradingEvent("OrderFilled", {
      order_id: order.id,
      account_id: order.accountId,
      broker_id: brokerId,
      price: markedUpFillPrice.toString(),
      volume: order.volume.toString(),
      remaining_volume: "0",
    });
    await recordDealerActivity(prisma, {
      brokerId,
      accountId: order.accountId,
      accountNumber: order.account.accountNumber,
      accountFullName: order.account.fullName,
      isDealingGroup: isDealingManagedAccount({
        group: order.account.group,
        brokerDealingModeOn: !!broker.dealingModeAt,
        dealingDeskAutoFillOn: !!broker.dealingDeskAutoFillAt,
      }),
      action: "POSITION_OPENED",
      symbol: order.symbol.name,
      side: order.side,
      volume: order.volume.toString(),
      values: { openPrice: markedUpFillPrice.toString(), origin: "dealer_accept" },
      orderId: order.id,
      positionId: result.id,
    });
    return NextResponse.json({ id: order.id, status: "FILLED", positionId: result.id, filledPrice: markedUpFillPrice.toString() });
  } catch (error) {
    if (error instanceof Error && error.message === "RACED") {
      return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    }
    throw error;
  }
}
