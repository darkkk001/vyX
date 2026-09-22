import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { ensureCoverageAccount } from "@/lib/coverage";
import { publishTradingEvent } from "@/lib/nats";

// Dealer order entry on the coverage account (2026-09-22). The dealing
// screen's order ticket, one-click widget and "order at price" had no
// endpoint at all ("order entry not available"): POST /api/manage/positions
// is the admin MANUAL-entry tool (any account, any price, a bookkeeping
// correction), deliberately not an execution path. This is the execution
// path for the desk: a MARKET order on the broker's own coverage account,
// filled at the live market price, zero commission, A_BOOK -- exactly the
// leg BOOK NOW creates, minus the client position it would be tied to. The
// dealer uses it to hedge net exposure by hand, or to lift / add coverage.
//
// Market only. A LIMIT / STOP on the coverage account needs the resting-
// order trigger to watch the coverage account, which nothing does today
// (flagged in docs/COVERAGE-BRIDGE-FEASIBILITY.md as part of the bridge).
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId;

  let body: { symbol?: string; side?: string; volume?: string | number; slPrice?: string | number | null; tpPrice?: string | number | null; type?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (body.type && body.type !== "MARKET") {
    return NextResponse.json({ error: "only MARKET orders can be placed on the coverage account (limit / stop need the coverage bridge)" }, { status: 400 });
  }
  const side = body.side === "BUY" || body.side === "SELL" ? body.side : null;
  const symbolName = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  let volume: Prisma.Decimal;
  try {
    volume = new Prisma.Decimal(body.volume ?? 0);
  } catch {
    return NextResponse.json({ error: "invalid volume" }, { status: 400 });
  }
  if (!side || !symbolName || volume.lte(0)) {
    return NextResponse.json({ error: "symbol, side (BUY|SELL) and a positive volume are required" }, { status: 400 });
  }

  const bs = await prisma.brokerSymbol.findFirst({
    where: { brokerId, symbol: { name: symbolName } },
    select: { minLot: true, maxLot: true, symbol: { select: { id: true, name: true, digits: true } } },
  });
  if (!bs) {
    return NextResponse.json({ error: `symbol ${symbolName} is not enabled for this broker` }, { status: 404 });
  }
  const symbol = bs.symbol;
  if (volume.lt(bs.minLot)) return NextResponse.json({ error: `volume below the minimum lot (${bs.minLot})` }, { status: 400 });
  if (volume.gt(bs.maxLot)) return NextResponse.json({ error: `volume above the maximum lot (${bs.maxLot})` }, { status: 400 });

  const live = await getFreshPrice(symbol.name);
  if (!live) {
    return NextResponse.json({ error: `no live price for ${symbol.name}` }, { status: 409 });
  }
  const fillPrice = side === "BUY" ? live.ask : live.bid;
  const toDec = (v: string | number | null | undefined) => (v == null || v === "" ? null : new Prisma.Decimal(v));
  let slPrice: Prisma.Decimal | null, tpPrice: Prisma.Decimal | null;
  try {
    slPrice = toDec(body.slPrice);
    tpPrice = toDec(body.tpPrice);
  } catch {
    return NextResponse.json({ error: "invalid SL / TP" }, { status: 400 });
  }
  // the same rule the trader's ticket enforces: SL on the losing side, TP on the winning side
  if (slPrice && (side === "BUY" ? slPrice.gte(fillPrice) : slPrice.lte(fillPrice))) return NextResponse.json({ error: "SL must be on the losing side of the fill price" }, { status: 400 });
  if (tpPrice && (side === "BUY" ? tpPrice.lte(fillPrice) : tpPrice.gte(fillPrice))) return NextResponse.json({ error: "TP must be on the winning side of the fill price" }, { status: 400 });

  const coverage = await ensureCoverageAccount(brokerId, session!.adminId);

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        brokerId,
        accountId: coverage.accountId,
        symbolId: symbol.id,
        side,
        type: "MARKET",
        volume,
        requestedPrice: fillPrice,
        idempotencyKey: `coverage_dealer_${randomUUID()}`,
        status: "FILLED",
        source: "ADMIN",
        filledPrice: fillPrice,
        filledAt: new Date(),
        slPrice,
        tpPrice,
      },
    });
    const position = await tx.position.create({
      data: {
        brokerId,
        accountId: coverage.accountId,
        symbolId: symbol.id,
        originOrderId: order.id,
        side,
        volume,
        openPrice: fillPrice,
        slPrice,
        tpPrice,
        bookType: "A_BOOK",
      },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "COVERAGE_ORDER_PLACED",
        entityType: "Position",
        entityId: position.id,
        newValue: { ticket: position.ticket, coverageAccountId: coverage.accountId, symbol: symbol.name, side, volume: volume.toString(), fillPrice: fillPrice.toString(), slPrice: slPrice?.toString() ?? null, tpPrice: tpPrice?.toString() ?? null },
      },
    });
    return { order, position };
  });

  await publishTradingEvent("OrderFilled", {
    order_id: result.order.id,
    account_id: coverage.accountId,
    broker_id: brokerId,
    price: fillPrice.toString(),
    volume: volume.toString(),
    remaining_volume: "0",
  }).catch((err) => console.error("publish coverage dealer OrderFilled failed", err));

  return NextResponse.json({
    positionId: result.position.id,
    ticket: result.position.ticket,
    coverageAccountId: coverage.accountId,
    symbol: symbol.name,
    side,
    volume: volume.toString(),
    fillPrice: fillPrice.toFixed(symbol.digits),
    slPrice: slPrice ? slPrice.toString() : null,
    tpPrice: tpPrice ? tpPrice.toString() : null,
  });
}
