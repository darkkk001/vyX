import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getLivePriceRow } from "@/lib/live-price";
import { checkAccountPreTradeMargin } from "@/lib/margin";
import { orderAuditFields } from "@/lib/order-audit";
import { validatePendingOrderDirection, validatePendingPriceDistance } from "@/lib/trading";
import {
  checkTradingHalted,
  checkCloseOnly,
  checkSymbolTradingMode,
  checkTradingSession,
  checkLotStep,
  checkGroupMaxLot,
  checkGroupMinLot,
  checkGroupTradingRestriction,
  checkGroupTradingHalted,
  checkGroupCloseOnly,
  checkGroupAllowedSymbol,
  checkAccountStatusForOpen,
  checkAccountTradingRights,
} from "@/lib/risk";

// Step 3b item 7 (owner 2026-10-07): the dealer's LIMIT / STOP orders on the broker's own hedge (coverage) account. A NEW ORDER PATH, so
// every gate a client order passes applies here too, at placement AND again when the price reaches the entry (lib/pending-trigger.ts,
// the same function every resting order goes through):
//   broker halt, broker close-only, the symbol's allowed sides, trading hours, volume step, the symbol's min / max volume, the group's
//   max and min volume, the group's allowed sides, the account's trading rights and status, the group's halt / close-only / allowed
//   symbols, the entry's side of the market and the symbol's stop distance, and the pre-trade margin on the entry price.
// What is deliberately NOT applied, exactly as for the hedge account's MARKET orders and as the audit Batch 3 decision leaves hedge legs
// out of every client limit: max open positions per account, per-account symbol exposure, the broker-wide open-lots limit, the daily loss
// limit, and the no-hedging rule (a hedge account hedges by design). Fill: the raw market price (a BUY at the ask, a SELL at the bid),
// zero commission, A_BOOK; never mirrored, never auto-hedged. Cancel is the dealer's cancel (POST /api/manage/orders/{id}/cancel).
// Cutover gate: docs/RUST-CUTOVER-PLAN.md 6.1 ("coverage resting orders").
export type CoveragePendingResult =
  | { ok: true; orderId: string; ticket: number | null; entry: string }
  | { ok: false; status: number; error: string; code?: string };

export type CoveragePendingParams = {
  brokerId: string;
  adminId: string;
  coverageAccountId: string;
  symbolName: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "STOP";
  volume: Prisma.Decimal;
  price: Prisma.Decimal;
  slPrice: Prisma.Decimal | null;
  tpPrice: Prisma.Decimal | null;
};

/** Does the hedge account hold funds, so that margin means something for it? */
export const hedgeAccountHoldsFunds = (a: { balance: Prisma.Decimal; credit: Prisma.Decimal }) => a.balance.add(a.credit).gt(0);

const refuse = (error: string, status = 400, code?: string): CoveragePendingResult => ({ ok: false, status, error, ...(code ? { code } : {}) });

export async function placeCoveragePendingOrder(p: CoveragePendingParams): Promise<CoveragePendingResult> {
  if (p.price.lte(0)) return refuse("the entry price must be above 0");
  const [bs, account, broker] = await Promise.all([
    prisma.brokerSymbol.findFirst({ where: { brokerId: p.brokerId, symbol: { name: p.symbolName }, enabled: true }, include: { symbol: true, tradingSessions: true } }),
    prisma.account.findUniqueOrThrow({ where: { id: p.coverageAccountId }, include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } } }),
    prisma.broker.findUniqueOrThrow({ where: { id: p.brokerId } }),
  ]);
  if (!bs) return refuse(`symbol ${p.symbolName} is not enabled for this broker`, 404);

  const gateError =
    checkTradingHalted(broker) ??
    checkCloseOnly(broker) ??
    checkSymbolTradingMode(bs.tradingMode, p.side) ??
    checkTradingSession(bs.tradingSessions, new Date(), bs.symbol.category) ??
    checkLotStep(p.volume, bs.minLot, bs.lotStep) ??
    (account.group ? checkGroupMaxLot(p.volume, account.group.maxLotSize) : null) ??
    (account.group ? checkGroupMinLot(p.volume, account.group.minLotSize, bs.minLot) : null) ??
    (account.group ? checkGroupTradingRestriction(account.group.tradingRestriction, p.side) : null) ??
    checkAccountTradingRights(account, "open") ??
    (account.group ? checkGroupTradingHalted(account.group) : null) ??
    checkAccountStatusForOpen(account) ??
    (account.group ? checkGroupCloseOnly(account.group) : null) ??
    (account.group ? checkGroupAllowedSymbol(account.group.restrictSymbols, account.group.allowedSymbols.map((s) => s.symbolId), bs.symbolId) : null);
  if (p.volume.lt(bs.minLot)) return refuse(`volume below the minimum lot (${bs.minLot})`);
  if (p.volume.gt(bs.maxLot)) return refuse(`volume above the maximum lot (${bs.maxLot})`);
  if (gateError) return refuse(gateError);

  const live = await getLivePriceRow(bs.symbol.name);
  if (!live) return refuse(`no live price for ${bs.symbol.name}`, 409);
  const marketRef = p.side === "BUY" ? live.ask : live.bid;
  const directionError = validatePendingOrderDirection({ type: p.type, side: p.side, entryPrice: p.price, marketPrice: marketRef });
  if (directionError) return refuse(directionError);
  const distanceError = validatePendingPriceDistance({ type: p.type, side: p.side, entryPrice: p.price, marketPrice: marketRef, digits: bs.symbol.digits, stopLevel: bs.stopLevel });
  if (distanceError) return refuse(distanceError);
  // SL on the losing side of the ENTRY, TP on the winning side (the same rule the trader's ticket enforces)
  if (p.slPrice && (p.side === "BUY" ? p.slPrice.gte(p.price) : p.slPrice.lte(p.price))) return refuse("SL must be on the losing side of the entry price");
  if (p.tpPrice && (p.side === "BUY" ? p.tpPrice.lte(p.price) : p.tpPrice.gte(p.price))) return refuse("TP must be on the winning side of the entry price");

  // The pre-trade margin applies once the hedge account holds funds (balance + credit above 0). The default hedge account is an unfunded
  // ledger (balance 0, see ensureCoverageAccount): a margin check on it would refuse every order, as it would its MARKET orders, which
  // never check margin. OWNER TO CONFIRM (reported with step 3b item 7).
  const marginError = !hedgeAccountHoldsFunds(account) ? null : await checkAccountPreTradeMargin(prisma, {
    accountId: account.id,
    leverage: account.leverage,
    marginCallLevel: account.group?.marginCallLevel ?? new Prisma.Decimal(100),
    newOrderContractSize: bs.symbol.contractSize,
    newOrderQuoteCurrency: bs.symbol.quoteCurrency,
    newOrderVolume: p.volume,
    newOrderFillPrice: p.price,
    newOrderSide: p.side,
    newOrderSymbolId: bs.symbolId,
  });
  if (marginError) return refuse(marginError.error);

  const order = await prisma.$transaction(async (tx) => {
    const o = await tx.order.create({
      data: {
        brokerId: p.brokerId,
        accountId: account.id,
        symbolId: bs.symbolId,
        side: p.side,
        type: p.type,
        volume: p.volume,
        requestedPrice: p.price,
        slPrice: p.slPrice,
        tpPrice: p.tpPrice,
        idempotencyKey: `coverage_dealer_pending_${crypto.randomUUID()}`,
        status: "PENDING",
        source: "ADMIN",
      },
    });
    await tx.auditLog.create({
      data: {
        brokerId: p.brokerId,
        actorAdminId: p.adminId,
        action: "COVERAGE_PENDING_ORDER_PLACED",
        entityType: "Order",
        entityId: o.id,
        newValue: { ...orderAuditFields(o, bs.symbol.name, account.accountNumber), requestedPrice: p.price.toString(), slPrice: p.slPrice?.toString() ?? null, tpPrice: p.tpPrice?.toString() ?? null, status: "PENDING", coverageAccountId: account.id },
      },
    });
    return o;
  });
  return { ok: true, orderId: order.id, ticket: (order as { ticket?: number | null }).ticket ?? null, entry: p.price.toFixed(bs.symbol.digits) };
}
