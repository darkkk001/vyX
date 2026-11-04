import "server-only";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkHedgingAllowed } from "@/lib/hedging";
import { evaluatePreTradeMargin, loadAccountMarginState } from "@/lib/margin";
import {
  checkTradingHalted,
  checkCloseOnly,
  checkSymbolTradingMode,
  checkTradingSession,
  checkLotStep,
  checkGroupMaxLot,
  checkGroupMinLot,
  checkGroupLotStep,
  riskCode,
  checkGroupTradingRestriction,
  checkGroupTradingHalted,
  checkAccountStatusForOpen,
  checkGroupCloseOnly,
  checkGroupAllowedSymbol,
  checkMaxOpenPositions,
  checkSymbolExposure,
  checkBrokerExposure,
  checkMaxDailyLoss,
  checkAccountTradingRights,
} from "@/lib/risk";

// One set of checks for every order staff place for a client (staff order brief, owner 2026-10-28): the market open (POST manage/positions), the
// LIMIT / STOP order (POST manage/accounts/[id]/orders) and the Manual position (POST manage/accounts/[id]/manual-positions). The same broker /
// symbol / account policies as the trader's own order, in the same order (lib/risk.ts), so the three staff paths can never drift apart.

export type StaffOrderInput = { symbolId: string; side: "BUY" | "SELL"; volume: Prisma.Decimal; slPrice: Prisma.Decimal | null; tpPrice: Prisma.Decimal | null; note: string | null };

const dec = (v: unknown): Prisma.Decimal | null | "bad" => {
  if (v == null || String(v).trim() === "") return null;
  try { return new Prisma.Decimal(String(v).replace(/,/g, "")); } catch { return "bad"; }
};

/** symbolId, side, volume (> 0), optional slPrice / tpPrice / note. */
export function parseStaffOrder(body: Record<string, unknown> | null): StaffOrderInput | { error: string } {
  const symbolId = typeof body?.symbolId === "string" ? body.symbolId : "";
  const side = body?.side === "SELL" ? "SELL" : body?.side === "BUY" ? "BUY" : null;
  if (!symbolId || !side) return { error: "symbolId and side are required" };
  const volume = dec(body?.volume);
  if (volume === "bad" || volume === null) return { error: "invalid volume" };
  if (!volume.gt(0)) return { error: "volume must be positive" };
  const slPrice = dec(body?.slPrice);
  if (slPrice === "bad") return { error: "invalid slPrice" };
  const tpPrice = dec(body?.tpPrice);
  if (tpPrice === "bad") return { error: "invalid tpPrice" };
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  return { symbolId, side, volume, slPrice, tpPrice, note };
}

export async function loadStaffAccount(brokerId: string, accountId: string) {
  return prisma.account.findUnique({ where: { id: accountId }, include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } } });
}
export type StaffAccount = NonNullable<Awaited<ReturnType<typeof loadStaffAccount>>>;

/** The account, the symbol and every risk check before an order is placed. `market` = false skips the trading-session check (a Manual position books
 *  a trade that already happened, at a time and price the admin states). A failure is the response to return. */
export async function staffOrderContext(brokerId: string, accountId: string, input: StaffOrderInput, opts: { market: boolean }) {
  const account = await loadStaffAccount(brokerId, accountId);
  if (!account || account.brokerId !== brokerId) return { response: NextResponse.json({ error: "account not found" }, { status: 404 }) };
  if (account.status !== "ACTIVE") return { response: NextResponse.json({ error: "account is not active" }, { status: 400 }) };
  const brokerSymbol = await prisma.brokerSymbol.findFirst({ where: { brokerId, symbolId: input.symbolId, enabled: true }, include: { symbol: true, tradingSessions: true } });
  if (!brokerSymbol) return { response: NextResponse.json({ error: "symbol not available for this broker" }, { status: 400 }) };
  const { volume, side } = input;
  if (volume.lt(brokerSymbol.minLot) || volume.gt(brokerSymbol.maxLot)) {
    return { response: NextResponse.json({ error: `volume must be between ${brokerSymbol.minLot} and ${brokerSymbol.maxLot}` }, { status: 400 }) };
  }
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
  const g = account.group;
  const riskError =
    checkTradingHalted(broker) ??
    checkCloseOnly(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, side) ??
    (opts.market ? checkTradingSession(brokerSymbol.tradingSessions, new Date(), brokerSymbol.symbol.category, brokerSymbol.symbol.name) : null) ??
    checkLotStep(volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
    (g ? checkGroupMaxLot(volume, g.maxLotSize) : null) ??
    (g ? checkGroupMinLot(volume, g.minLotSize, brokerSymbol.minLot) : null) ??
    (g ? checkGroupLotStep(volume, g.lotStep, g.minLotSize, brokerSymbol) : null) ??
    (g ? checkGroupTradingRestriction(g.tradingRestriction, side) : null) ??
    checkAccountTradingRights(account, "open") ??
    (g ? checkGroupTradingHalted(g) : null) ??
    checkAccountStatusForOpen(account) ??
    (g ? checkGroupCloseOnly(g) : null) ??
    (g ? checkGroupAllowedSymbol(g.restrictSymbols, g.allowedSymbols.map((s) => s.symbolId), brokerSymbol.symbolId) : null) ??
    (await checkHedgingAllowed(prisma, broker, { accountId, symbolId: input.symbolId, side })) ??
    (await checkMaxOpenPositions(prisma, accountId, broker.maxOpenPositionsPerAccount)) ??
    (await checkSymbolExposure(prisma, accountId, input.symbolId, volume, brokerSymbol.maxExposure)) ??
    (await checkBrokerExposure(prisma, brokerId, volume, broker.totalExposureLimit)) ??
    (opts.market ? await checkMaxDailyLoss(prisma, accountId, account.maxDailyLoss) : null);
  if (riskError) return { response: NextResponse.json({ error: riskError, ...riskCode(riskError) }, { status: 400 }) };
  return { account, brokerSymbol, broker };
}

/** The pre-trade margin gate (lib/margin.ts) at `price`: null = it fits; otherwise the refusal body (the same one the client route returns). */
export async function staffMarginRefusal(brokerId: string, account: StaffAccount, brokerSymbol: { symbolId: string; symbol: { contractSize: Prisma.Decimal; quoteCurrency: string } }, side: "BUY" | "SELL", volume: Prisma.Decimal, price: Prisma.Decimal) {
  const state = await loadAccountMarginState(prisma, account.id, account.leverage, [brokerSymbol.symbol.quoteCurrency], brokerId);
  if (!state) return { error: "NO_CONVERSION_RATE" as const, required: null, available: null, balance: account.balance.toFixed(2) };
  return evaluatePreTradeMargin(state, {
    leverage: account.leverage,
    marginCallLevel: account.group?.marginCallLevel ?? new Prisma.Decimal(100),
    newOrderContractSize: brokerSymbol.symbol.contractSize,
    newOrderQuoteCurrency: brokerSymbol.symbol.quoteCurrency,
    newOrderVolume: volume,
    newOrderFillPrice: price,
    newOrderSide: side,
    newOrderSymbolId: brokerSymbol.symbolId,
  });
}

/** "Opened BUY 0.10 XAUUSD for 50005721" / "Placed BUY LIMIT 0.10 XAUUSD @ 4,050.00 for 50005721" (staff activity, staff order brief point 3). */
export function staffActivityText(kind: "open" | "pending" | "manual", p: { side: string; type?: string; volume: string; symbol: string; price?: string; digits?: number; account: string; reason?: string }) {
  const price = p.price ? Number(p.price).toLocaleString("en-US", { minimumFractionDigits: p.digits ?? 2, maximumFractionDigits: p.digits ?? 2 }) : "";
  if (kind === "open") return `Opened ${p.side} ${p.volume} ${p.symbol} for ${p.account}`;
  if (kind === "pending") return `Placed ${p.side} ${p.type} ${p.volume} ${p.symbol} @ ${price} for ${p.account}`;
  return `Manual position added: ${p.side} ${p.volume} ${p.symbol} @ ${price} for ${p.account}${p.reason ? `. Reason: ${p.reason}` : ""}`;
}
