import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { openPositionFromOrder } from "@/lib/dealing";
import { executeQueuedCloseInTx, afterQueuedCloseExecuted } from "@/lib/queued-close";
import { resolveBookType, applySpreadMarkup } from "@/lib/group-pricing";
import { resolveFillPricing, logSpreadWarning } from "@/lib/pricing-engine";
import { publishTradingEvent } from "@/lib/nats";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";
import { orderAuditFields } from "@/lib/order-audit";
import { checkAccountPreTradeMargin } from "@/lib/margin";
import { Prisma } from "@prisma/client";
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

  const order = await prisma.order.findUnique({
    where: { id },
    include: { symbol: { select: { name: true } }, account: { select: { accountNumber: true, fullName: true } } },
  });
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
        // a declined CLOSE requote leaves the position open and unlocked (docs/CLOSES-RESPECT-DEALER-MODE.md)
        if (order.closesPositionId) await tx.position.updateMany({ where: { id: order.closesPositionId, closePendingOrderId: id }, data: { closePendingOrderId: null } });
        await tx.auditLog.create({
          data: {
            brokerId: order.brokerId,
            action: "DEALING_ORDER_REQUOTE_REJECTED",
            entityType: "Order",
            entityId: order.id,
            oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: "REQUOTED", requotedPrice: order.requotedPrice!.toString() },
            newValue: { status: "CANCELLED", cancelledBy: "CLIENT" },
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

  if (order.closesPositionId) {
    // Accepting a requote on a queued CLOSE: close the position at the dealer's offered price
    // (no markup; the market must be open and trading not halted -- the open-side battery does
    // not apply to a close).
    const closeRiskError = checkTradingHalted(broker) ?? checkTradingSession(brokerSymbol.tradingSessions, new Date(), brokerSymbol.symbol.category);
    if (closeRiskError) {
      return NextResponse.json({ error: closeRiskError }, { status: 400 });
    }
    const closePrice = order.requotedPrice!;
    const before = await prisma.position.findUnique({ where: { id: order.closesPositionId }, select: { volume: true, ticket: true } });
    const result = await prisma.$transaction(async (tx) => {
      const r = await executeQueuedCloseInTx(tx, { order, fromStatus: "REQUOTED", closePrice, note: "Dealer close (requote accepted by client)" });
      if (r.kind === "closed") {
        await tx.auditLog.create({
          data: {
            brokerId: order.brokerId,
            action: "DEALING_CLOSE_REQUOTE_ACCEPTED",
            entityType: "Position",
            entityId: order.closesPositionId!,
            oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: "REQUOTED", requotedPrice: closePrice.toString(), closesTicket: before?.ticket ?? null },
            newValue: { status: "FILLED", closePrice: closePrice.toString(), closeVolume: r.closeVolume.toString(), partial: r.outcome.partial, realizedPnl: r.outcome.realizedPnl.toString() },
          },
        });
      }
      return r;
    });
    if (result.kind === "raced") return NextResponse.json({ error: "order was already actioned" }, { status: 409 });
    if (result.kind === "position_gone") return NextResponse.json({ error: "position was already closed; the close request is cancelled" }, { status: 409 });
    await afterQueuedCloseExecuted(prisma, {
      brokerId: order.brokerId,
      accountId: session.accountId,
      accountNumber: order.account.accountNumber,
      accountFullName: order.account.fullName,
      symbolName: brokerSymbol.symbol.name,
      side: order.side,
      positionId: order.closesPositionId,
      positionVolumeBefore: before?.volume ?? order.volume,
      result,
      origin: "client_requote_accept",
    });
    return NextResponse.json({ id: order.id, status: "FILLED", positionId: order.closesPositionId, closed: true, partial: result.outcome.partial, closePrice: closePrice.toString() });
  }

  const riskError =
    checkTradingHalted(broker) ??
    checkCloseOnly(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, order.side) ??
    checkTradingSession(brokerSymbol.tradingSessions, new Date(), brokerSymbol.symbol.category) ??
    checkLotStep(order.volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
    (account.group ? checkGroupMaxLot(order.volume, account.group.maxLotSize) : null) ??
    (account.group ? checkGroupTradingRestriction(account.group.tradingRestriction, order.side) : null) ??
    (account.group ? checkGroupTradingHalted(account.group) : null) ??
    (account.group ? checkGroupCloseOnly(account.group) : null) ??
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
  // No raw bid/ask tick at this fill point -- the requoted price already
  // IS the base (see this branch's own comment above) -- so
  // liveBaseSpreadPips is null, meaning a target-total-spread level (if
  // one wins here) falls back to its own configured markup (Q1), never
  // blocks accepting the requote.
  const pricing = await resolveFillPricing(prisma, {
    pricingEngineEnabled: broker.pricingEngineEnabled,
    accountId: account.id,
    accountTypeId: account.accountTypeId,
    groupId: account.groupId,
    symbolId: order.symbolId,
    brokerSpreadMarkup: brokerSymbol.spreadMarkup,
    brokerCommissionPerLot: brokerSymbol.commissionPerLot,
    brokerSwapLong: brokerSymbol.swapLong,
    brokerSwapShort: brokerSymbol.swapShort,
    liveBaseSpreadPips: null,
  });
  logSpreadWarning({ accountId: account.id, symbolId: order.symbolId, brokerId: order.brokerId }, pricing.warning);
  const fillPrice = applySpreadMarkup({ side: order.side, price: order.requotedPrice!, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits });
  // Audit 2026-09-24 (money): accepting a requote is a fill like any other, so it passes the same pre-trade margin
  // gate as a direct order (the account may have changed since it was queued).
  const marginError = await checkAccountPreTradeMargin(prisma, {
    accountId: account.id,
    leverage: account.leverage,
    marginCallLevel: account.group?.marginCallLevel ?? new Prisma.Decimal(100),
    newOrderContractSize: brokerSymbol.symbol.contractSize,
    newOrderQuoteCurrency: brokerSymbol.symbol.quoteCurrency,
    newOrderVolume: order.volume,
    newOrderFillPrice: fillPrice,
    newOrderSide: order.side,
    newOrderSymbolId: order.symbolId,
  });
  if (marginError) {
    return NextResponse.json(marginError, { status: 400 });
  }
  const bookType = resolveBookType(account.group.category);

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
          oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: "REQUOTED", requotedPrice: order.requotedPrice!.toString() },
          newValue: { status: "FILLED", filledPrice: fillPrice.toString() },
        },
      });
      return pos;
    });
    // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- mirror hook gap fix: accepting
    // a requote is a real fill, same as any other fill path.
    await mirror.onFillPosition(prisma, position, brokerSymbol.symbol.name).catch((err) => console.error("mirror.onFill failed", err));
    // auto-hedge (lib/coverage.ts): a no-op unless the desk is in auto-fill with auto-hedge on
    await coverage.onFillAutoHedge(prisma, { positionId: position.id, brokerId: session.brokerId });
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
