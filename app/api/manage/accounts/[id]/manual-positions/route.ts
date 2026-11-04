import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { validateSlTp } from "@/lib/trading";
import { resolveBookType, chargeCommission } from "@/lib/group-pricing";
import { resolveFillPricing } from "@/lib/pricing-engine";
import { writeOpenDealInTx } from "@/lib/deals";
import { publishTradingEvent } from "@/lib/nats";
import { hedgedUsedMargin, loadAccountMarginState, requiredMarginFor } from "@/lib/margin";
import { parseStaffOrder, staffActivityText, staffOrderContext } from "@/lib/staff-order";

// Manual position (staff order brief 37b, owner 2026-10-28; MT5-Manager "Add position"), BROKER_ADMIN only.
//   POST { symbolId, side, volume, openPrice, openedAt?, openedAtSource? "price-lookup" | "edited", slPrice?, tpPrice?, reason, dryRun? }
// Creates an OPEN Position (+ its Order and deal rows) at openPrice, openedAt (default now; never in the future, never before the account opened).
// No market: no fill against the live price, no LP / FIX route, no auto-hedge, no coverage leg, no mirror / copy rule, no Smart Dealer. The same
// server rules otherwise (lib/staff-order.ts), SL / TP against openPrice and the stop level, and a margin check with the account's leverage: refused
// if it would put the account below stop-out. Marked manual (Position.manual, source ADMIN) everywhere; audit MANUAL_POSITION_ADDED with the reason
// and whether openedAt was the server's suggestion or edited.
// `dryRun: true` answers the preview the confirm shows (floating P/L now, margin used and margin level after), from the same figures, and writes nothing.

const STOP_OUT_REFUSAL = "This position would put the account below its stop-out level.";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) return NextResponse.json({ error: "Only a broker admin can add a manual position." }, { status: 403 });
  const brokerId = session!.brokerId!;
  const { id: accountId } = await params;
  const body = await request.json().catch(() => null);
  const dryRun = body?.dryRun === true;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason && !dryRun) return NextResponse.json({ error: "Enter the reason." }, { status: 400 });
  let openPrice: Prisma.Decimal;
  try { openPrice = new Prisma.Decimal(String(body?.openPrice ?? "").replace(/,/g, "")); } catch { return NextResponse.json({ error: "invalid openPrice" }, { status: 400 }); }
  if (!openPrice.gt(0)) return NextResponse.json({ error: "openPrice must be positive" }, { status: 400 });
  const input = parseStaffOrder(body);
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });
  const { side, volume, slPrice, tpPrice } = input;
  const ctx = await staffOrderContext(brokerId, accountId, input, { market: false });
  if (ctx.response) return ctx.response;
  const { account, brokerSymbol, broker } = ctx;
  const now = new Date();
  let openedAt = now;
  if (body?.openedAt != null && String(body.openedAt).trim() !== "") {
    const t = new Date(String(body.openedAt));
    if (Number.isNaN(t.getTime())) return NextResponse.json({ error: "invalid openedAt" }, { status: 400 });
    if (t.getTime() > now.getTime()) return NextResponse.json({ error: "The open time cannot be in the future." }, { status: 400 });
    if (t.getTime() < account.createdAt.getTime()) return NextResponse.json({ error: "The open time cannot be before the account opened." }, { status: 400 });
    openedAt = t;
  }
  const openedAtSource = body?.openedAtSource === "price-lookup" ? "price-lookup" : body?.openedAtSource === "edited" ? "edited" : "default";
  const digits = brokerSymbol.symbol.digits;
  const slTpError = validateSlTp({ side, referencePrice: openPrice, slPrice, tpPrice, digits, stopLevel: brokerSymbol.stopLevel });
  if (slTpError) return NextResponse.json({ error: slTpError }, { status: 400 });

  // the margin after, with the account's leverage, on the same state every pre-trade check uses
  const state = await loadAccountMarginState(prisma, account.id, account.leverage, [brokerSymbol.symbol.quoteCurrency], brokerId);
  const rate = state?.rateFor(brokerSymbol.symbol.quoteCurrency) ?? null;
  if (!state || !rate) return NextResponse.json({ error: "NO_CONVERSION_RATE", required: null, available: null, balance: account.balance.toFixed(2) }, { status: 400 });
  const live = await getFreshPrice(brokerSymbol.symbol.name);
  // floating P/L now: a BUY is valued at the bid, a SELL at the ask (the side it would close at); none without a live price
  const mark = live ? (side === "BUY" ? live.bid : live.ask) : null;
  const sign = side === "BUY" ? 1 : -1;
  const floatingPnl = mark ? mark.sub(openPrice).mul(sign).mul(brokerSymbol.symbol.contractSize).mul(volume).mul(rate) : new Prisma.Decimal(0);
  const fullMargin = requiredMarginFor(volume, brokerSymbol.symbol.contractSize, openPrice, account.leverage).mul(rate);
  const usedAfter = hedgedUsedMargin([...state.legs, { symbolKey: brokerSymbol.symbolId, side, volume, margin: fullMargin, hedgedMarginPct: state.pctFor(brokerSymbol.symbolId) }]);
  const equityAfter = state.equity.add(floatingPnl);
  const levelAfter = usedAfter.gt(0) ? equityAfter.div(usedAfter).mul(100) : null;
  const stopOut = account.group?.stopOutLevel ?? new Prisma.Decimal(50);
  const preview = {
    openPrice: openPrice.toFixed(digits),
    openedAt: openedAt.toISOString(),
    currentPrice: mark ? mark.toFixed(digits) : null,
    floatingPnl: floatingPnl.toFixed(2),
    marginUsedAfter: usedAfter.toFixed(2),
    marginLevelAfter: levelAfter ? levelAfter.toFixed(2) : null,
    stopOutLevel: stopOut.toFixed(2),
    currency: account.currency,
  };
  // MT5: an order that does not raise the used margin (a hedge) never fails the check; otherwise the level after must stay above stop-out
  const belowStopOut = usedAfter.gt(state.usedMargin) && levelAfter !== null && levelAfter.lte(stopOut);
  if (dryRun) return NextResponse.json({ preview, refused: belowStopOut ? STOP_OUT_REFUSAL : null });
  if (belowStopOut) return NextResponse.json({ error: STOP_OUT_REFUSAL, code: "BELOW_STOP_OUT", preview }, { status: 400 });

  const pricing = await resolveFillPricing(prisma, {
    pricingEngineEnabled: broker.pricingEngineEnabled, accountId: account.id, groupId: account.groupId, symbolId: brokerSymbol.symbolId,
    brokerSpreadMarkup: brokerSymbol.spreadMarkup, brokerCommissionPerLot: brokerSymbol.commissionPerLot, brokerSwapLong: brokerSymbol.swapLong, brokerSwapShort: brokerSymbol.swapShort,
    liveBaseSpreadPips: null,
  });
  const activity = staffActivityText("manual", { side, volume: volume.toString(), symbol: brokerSymbol.symbol.name, price: openPrice.toString(), digits, account: account.accountNumber, reason });
  const bookType = resolveBookType(account.group.category);
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        brokerId, accountId, symbolId: brokerSymbol.symbolId, side, type: "MARKET", volume, requestedPrice: openPrice, slPrice, tpPrice,
        idempotencyKey: `manualpos_${randomUUID()}`, status: "FILLED", source: "ADMIN", filledPrice: openPrice, filledAt: openedAt,
        executedAt: openedAt, executionMode: "DEALER", platform: "Backoffice", routing: bookType,
      },
    });
    const position = await tx.position.create({
      data: { brokerId, accountId, symbolId: brokerSymbol.symbolId, originOrderId: order.id, side, volume, openPrice, slPrice, tpPrice, bookType, openedAt, manual: true },
    });
    await chargeCommission(tx, { brokerId, accountId, positionId: position.id, commissionPerLot: pricing.commissionPerLot, volume });
    await writeOpenDealInTx(tx, { positionId: position.id, reason: "ADMIN", adminId: session!.adminId });
    await tx.auditLog.create({
      data: {
        brokerId, actorAdminId: session!.adminId, action: "MANUAL_POSITION_ADDED", entityType: "Position", entityId: position.id,
        newValue: {
          accountId, accountNumber: account.accountNumber, symbol: brokerSymbol.symbol.name, side, volume: volume.toString(), openPrice: openPrice.toString(),
          openedAt: openedAt.toISOString(), openedAtSource, reason, manual: true, activity,
        },
      },
    });
    return { order, position };
  });
  // a real position on the account: the live views update at once (no mirror, hedge or coverage: a manual position never touches the market)
  await publishTradingEvent("OrderFilled", { order_id: result.order.id, account_id: accountId, broker_id: brokerId, price: openPrice.toString(), volume: volume.toString(), remaining_volume: "0" });
  return NextResponse.json({ positionId: result.position.id, manual: true, preview }, { status: 201 });
}
