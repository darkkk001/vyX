import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publishTradingEvent } from "@/lib/nats";
import { createNotification } from "@/lib/notifications";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";
import { deskIsOn, orderRoute, LP_NOT_CONNECTED, SYSTEM_ACCOUNT_ORDER } from "@/lib/dealing-routing";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { resolveBookType, applySpreadMarkup, pipSize, chargeCommission } from "@/lib/group-pricing";
import { resolveFillPricing, logSpreadWarning } from "@/lib/pricing-engine";
import { checkAccountPreTradeMargin } from "@/lib/margin";
import { orderAuditFields } from "@/lib/order-audit";
import { getLivePriceRow, getFreshPrices } from "@/lib/live-price";
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
  evaluateLiveMarketPrice,
  checkPriceFreshness,
  checkSlippage,
  PENDING_TRIGGER_MAX_SLIPPAGE_PIPS,
} from "@/lib/risk";

// ---------------------------------------------------------------------------
// Pending LIMIT / STOP triggering (audit 2026-09-24 Batch 4). SERVER-side: the engine's tick hook calls the web on
// the tick that crosses a resting order's entry (engine/market-data/src/risk_hook.rs), the 60 s full pass and the
// 5-minute cron sweep everything (app/api/internal/margin-monitor). Before, a pending order filled only while a
// client was connected, and a rejected trigger was re-POSTed on every tick.
//
// One fill routine for both origins (the server trigger, and POST /api/trade/orders/[id]/fill from an older terminal):
// - the order is CLAIMED with a status-guarded update, so two triggers can never both fill it;
// - a failure that will not go away by itself (margin, lot rules, trading halted / close-only, symbol not allowed, a
//   limit reached) REJECTS the order with the reason, once, and tells the trader -- MT5's "[no money]" behaviour;
// - a failure that is about the market right now (no fresh price, session closed) KEEPS it pending for the next pass.
// ---------------------------------------------------------------------------

export type TriggerOutcome =
  | { kind: "filled"; order: unknown; position: unknown; fillPrice: string }
  | { kind: "queued"; order: unknown }
  | { kind: "rejected"; reason: string; detail?: Record<string, string> }
  | { kind: "kept"; reason: string }
  | { kind: "skipped"; reason: string }; // not PENDING any more (filled / cancelled / claimed by another trigger)

/** Transient: about the market at this moment, retried on the next pass. Everything else rejects the order. */
const TRANSIENT = new Set(["NO_LIVE_FEED", "PRICE_STALE", "MARKET_CLOSED"]);
function isTransient(reason: string) {
  return TRANSIENT.has(reason) || /market is closed|trading session|outside.*session/i.test(reason);
}

/** Does the price reach the entry? A BUY trades at the ask, a SELL at the bid. */
export function pendingTriggered(order: { side: "BUY" | "SELL"; type: string }, entry: Prisma.Decimal, bid: Prisma.Decimal, ask: Prisma.Decimal): boolean {
  const limit = order.type === "LIMIT";
  if (order.side === "BUY") return limit ? ask.lte(entry) : ask.gte(entry);
  return limit ? bid.gte(entry) : bid.lte(entry);
}

async function rejectPending(
  order: { id: string; brokerId: string; accountId: string; side: string; volume: Prisma.Decimal; type: string; requestedPrice: Prisma.Decimal | null; symbol: { name: string } },
  accountNumber: string,
  reason: string,
  origin: "server" | "client"
): Promise<boolean> {
  const done = await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({ where: { id: order.id, status: "PENDING" }, data: { status: "REJECTED", rejectionReason: reason } });
    if (claimed.count === 0) return false;
    await tx.auditLog.create({
      data: {
        brokerId: order.brokerId,
        action: "PENDING_ORDER_REJECTED_AT_TRIGGER",
        entityType: "Order",
        entityId: order.id,
        oldValue: { ...orderAuditFields(order as never, order.symbol.name, accountNumber), status: "PENDING", requestedPrice: order.requestedPrice?.toString() ?? null },
        newValue: { status: "REJECTED", reason, origin },
      },
    });
    return true;
  });
  if (!done) return false;
  await createNotification(prisma, {
    brokerId: order.brokerId,
    accountId: order.accountId,
    type: "PENDING_ORDER_REJECTED",
    title: `Pending order rejected: ${order.symbol.name}`,
    body: `Your ${order.side} ${order.type} ${order.volume.toString()} ${order.symbol.name} at ${order.requestedPrice?.toString() ?? "?"} reached its price but could not be filled: ${reason}.`,
    entityType: "Order",
    entityId: order.id,
  }).catch((err) => console.error("[pending-trigger] notification failed", err));
  await publishTradingEvent("OrderRejected", { order_id: order.id, account_id: order.accountId, broker_id: order.brokerId, reason }).catch(() => {});
  return true;
}

/**
 * Fill (or queue for the dealer, or reject) one resting order that has reached its price. `triggerPrice` is the
 * price that crossed the entry: the server's own bid/ask for a server trigger, the client's price for the legacy
 * route (checked against the live price as before).
 */
export async function triggerPendingOrder(orderId: string, triggerPrice: string, origin: "server" | "client"): Promise<TriggerOutcome> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { symbol: { select: { name: true } } } });
  if (!order || order.status !== "PENDING" || (order.type !== "LIMIT" && order.type !== "STOP")) {
    return { kind: "skipped", reason: order ? `order is ${order.status}` : "order not found" };
  }

  const [brokerSymbol, account, broker] = await Promise.all([
    prisma.brokerSymbol.findFirst({ where: { brokerId: order.brokerId, symbolId: order.symbolId }, include: { symbol: true, tradingSessions: true } }),
    prisma.account.findUniqueOrThrow({ where: { id: order.accountId }, include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } } }),
    prisma.broker.findUniqueOrThrow({ where: { id: order.brokerId } }),
  ]);
  const livePrice = brokerSymbol ? await getLivePriceRow(brokerSymbol.symbol.name) : null;

  const fail = async (reason: string, detail?: Record<string, string>): Promise<TriggerOutcome> => {
    if (isTransient(reason)) return { kind: "kept", reason };
    const rejected = await rejectPending(order, account.accountNumber, reason, origin);
    return rejected ? { kind: "rejected", reason, detail } : { kind: "skipped", reason: "already handled" };
  };

  if (!brokerSymbol || !brokerSymbol.enabled) return fail("symbol is no longer available");
  if (account.status !== "ACTIVE") return fail("account is not active");

  const riskError =
    checkTradingHalted(broker) ??
    checkCloseOnly(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, order.side) ??
    checkTradingSession(brokerSymbol.tradingSessions, new Date(), brokerSymbol.symbol.category) ??
    checkLotStep(order.volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
    evaluateLiveMarketPrice(livePrice, brokerSymbol.symbol.name, triggerPrice) ??
    checkPriceFreshness(livePrice) ??
    (account.group ? checkGroupMaxLot(order.volume, account.group.maxLotSize) : null) ??
    (account.group ? checkGroupTradingRestriction(account.group.tradingRestriction, order.side) : null) ??
    (account.group ? checkGroupTradingHalted(account.group) : null) ??
    (account.group ? checkGroupCloseOnly(account.group) : null) ??
    (account.group ? checkGroupAllowedSymbol(account.group.restrictSymbols, account.group.allowedSymbols.map((s) => s.symbolId), order.symbolId) : null) ??
    (await checkMaxOpenPositions(prisma, order.accountId, broker.maxOpenPositionsPerAccount)) ??
    (await checkSymbolExposure(prisma, order.accountId, order.symbolId, order.volume, brokerSymbol.maxExposure)) ??
    (await checkBrokerExposure(prisma, order.brokerId, order.volume, broker.totalExposureLimit)) ??
    (await checkMaxDailyLoss(prisma, order.accountId, account.maxDailyLoss));
  if (riskError) return fail(riskError);

  // Phase 2 batch 2: an A_BOOK group without a connected LP / the system coverage account never fills a trigger
  const route = orderRoute(account.group, deskIsOn(broker));
  if (route === "NO_LP") return fail(LP_NOT_CONNECTED.code, { message: LP_NOT_CONNECTED.error });
  if (route === "SYSTEM") return fail(SYSTEM_ACCOUNT_ORDER.code, { message: SYSTEM_ACCOUNT_ORDER.error });
  const wantsQueue = route === "QUEUE";

  if (wantsQueue) {
    // The triggered order becomes a MARKET order waiting for the dealer (unchanged behaviour), claimed once.
    const originalType = order.type;
    const originalRequestedPrice = order.requestedPrice?.toString() ?? null;
    const queued = await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({ where: { id: order.id, status: "PENDING", type: originalType }, data: { type: "MARKET", requestedPrice: triggerPrice } });
      if (claimed.count === 0) return null;
      await tx.auditLog.create({
        data: {
          brokerId: order.brokerId,
          action: "PENDING_ORDER_QUEUED_FOR_DEALING",
          entityType: "Order",
          entityId: order.id,
          oldValue: { ...orderAuditFields(order, order.symbol.name, account.accountNumber), type: originalType, requestedPrice: originalRequestedPrice, status: "PENDING" },
          newValue: { triggerPrice, type: "MARKET", requestedPrice: triggerPrice, status: "PENDING", origin },
        },
      });
      return tx.order.findUniqueOrThrow({ where: { id: order.id } });
    });
    if (!queued) return { kind: "skipped", reason: "already handled" };
    await createNotification(prisma, {
      brokerId: order.brokerId,
      type: "DEALING_ORDER_PENDING",
      title: "Order awaiting dealer review",
      body: `${account.accountNumber}, ${order.side} ${order.volume.toString()} ${brokerSymbol.symbol.name} (triggered pending order)`,
      entityType: "Order",
      entityId: order.id,
    });
    await publishTradingEvent("DealingQueued", {
      order_id: order.id,
      broker_id: order.brokerId,
      account_id: order.accountId,
      account_number: account.accountNumber,
      account_full_name: account.fullName,
      symbol: order.symbol.name,
      digits: brokerSymbol.symbol.digits,
      side: order.side,
      volume: order.volume.toString(),
      requested_price: triggerPrice,
      created_at: order.createdAt.toISOString(),
      live_bid: livePrice?.bid.toString() ?? null,
      live_ask: livePrice?.ask.toString() ?? null,
    });
    await recordDealerActivity(prisma, {
      brokerId: order.brokerId,
      accountId: order.accountId,
      accountNumber: account.accountNumber,
      accountFullName: account.fullName,
      isDealingGroup: wantsQueue,
      action: "ORDER_TRIGGERED",
      symbol: order.symbol.name,
      side: order.side,
      volume: order.volume.toString(),
      values: { triggerPrice, originalRequestedPrice, originalType, origin },
      orderId: order.id,
    });
    return { kind: "queued", order: queued };
  }

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
    liveBaseSpreadPips: livePrice ? livePrice.ask.sub(livePrice.bid).div(pipSize(brokerSymbol.symbol.digits)) : null,
  });
  logSpreadWarning({ accountId: account.id, symbolId: order.symbolId, brokerId: order.brokerId }, pricing.warning);
  const serverRef = livePrice ? (order.side === "BUY" ? livePrice.ask : livePrice.bid) : new Prisma.Decimal(triggerPrice);
  const fillPrice = applySpreadMarkup({ side: order.side, price: serverRef, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits });
  const slippageError = checkSlippage({ clientReferencePrice: triggerPrice, serverFillPrice: fillPrice, maxSlippagePips: PENDING_TRIGGER_MAX_SLIPPAGE_PIPS, digits: brokerSymbol.symbol.digits });
  if (slippageError) {
    // the market jumped past the entry: MT5 fills at the next price; here the order waits for the next pass
    return { kind: "kept", reason: slippageError };
  }
  const marginError = await checkAccountPreTradeMargin(prisma, {
    accountId: order.accountId,
    leverage: account.leverage,
    marginCallLevel: account.group?.marginCallLevel ?? new Prisma.Decimal(100),
    newOrderContractSize: brokerSymbol.symbol.contractSize,
    newOrderQuoteCurrency: brokerSymbol.symbol.quoteCurrency,
    newOrderVolume: order.volume,
    newOrderFillPrice: fillPrice,
    newOrderSide: order.side,
    newOrderSymbolId: order.symbolId,
  });
  if (marginError) return fail(marginError.error, { required: marginError.required, available: marginError.available });

  const bookType = resolveBookType(account.group.category);
  const result = await prisma.$transaction(async (tx) => {
    // status-guarded claim: the server trigger and an older terminal's fill POST can never both fill this order
    const claimed = await tx.order.updateMany({ where: { id: order.id, status: "PENDING" }, data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date() } });
    if (claimed.count === 0) return null;
    const filledOrder = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
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
    await tx.auditLog.create({
      data: {
        brokerId: order.brokerId,
        action: "ORDER_TRIGGERED_AND_FILLED",
        entityType: "Position",
        entityId: position.id,
        oldValue: {
          ...orderAuditFields(order, order.symbol.name, account.accountNumber),
          requestedPrice: order.requestedPrice?.toString() ?? null,
          slPrice: order.slPrice?.toString() ?? null,
          tpPrice: order.tpPrice?.toString() ?? null,
          status: "PENDING",
        },
        newValue: { triggerPrice, filledPrice: fillPrice.toString(), status: "FILLED", origin },
      },
    });
    return { order: filledOrder, position };
  });
  if (!result) return { kind: "skipped", reason: "already handled" };

  await mirror.onFillPosition(prisma, result.position, order.symbol.name).catch((err) => console.error("mirror.onFill failed", err));
  await coverage.onFillAutoHedge(prisma, { positionId: result.position.id, brokerId: order.brokerId });
  await publishTradingEvent("OrderFilled", {
    order_id: order.id,
    account_id: order.accountId,
    broker_id: order.brokerId,
    price: fillPrice.toString(),
    volume: order.volume.toString(),
    remaining_volume: "0",
  });
  await recordDealerActivity(prisma, {
    brokerId: order.brokerId,
    accountId: order.accountId,
    accountNumber: account.accountNumber,
    accountFullName: account.fullName,
    isDealingGroup: wantsQueue,
    action: "POSITION_OPENED",
    symbol: order.symbol.name,
    side: order.side,
    volume: order.volume.toString(),
    values: { openPrice: fillPrice.toString(), origin: origin === "server" ? "pending_trigger_server" : "pending_trigger" },
    orderId: order.id,
    positionId: result.position.id,
  });
  return { kind: "filled", order: result.order, position: result.position, fillPrice: fillPrice.toString() };
}

/**
 * Server sweep: every resting LIMIT / STOP on `symbols` (all when omitted) whose entry the current price reaches is
 * triggered. Called by the engine's tick hook (?symbols=), its 60 s full pass, and the 5-minute cron.
 */
export async function evaluatePendingTriggers(symbols?: string[]): Promise<{ checked: number; filled: number; queued: number; rejected: number; kept: number }> {
  const orders = await prisma.order.findMany({
    where: { status: "PENDING", type: { in: ["LIMIT", "STOP"] }, requestedPrice: { not: null }, ...(symbols && symbols.length ? { symbol: { name: { in: symbols } } } : {}) },
    select: { id: true, side: true, type: true, requestedPrice: true, symbol: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  const prices = await getFreshPrices([...new Set(orders.map((o) => o.symbol.name))]);
  const out = { checked: orders.length, filled: 0, queued: 0, rejected: 0, kept: 0 };
  for (const o of orders) {
    const p = prices.get(o.symbol.name);
    if (!p || !pendingTriggered(o, o.requestedPrice!, p.bid, p.ask)) continue;
    const triggerPrice = (o.side === "BUY" ? p.ask : p.bid).toString();
    try {
      const r = await triggerPendingOrder(o.id, triggerPrice, "server");
      if (r.kind === "filled") out.filled++;
      else if (r.kind === "queued") out.queued++;
      else if (r.kind === "rejected") out.rejected++;
      else if (r.kind === "kept") out.kept++;
    } catch (err) {
      console.error("[pending-trigger] order failed", o.id, err);
    }
  }
  return out;
}
