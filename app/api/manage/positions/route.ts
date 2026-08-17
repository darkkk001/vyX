import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Manual position open -- a dealing desk placing a MARKET trade for an
// account directly (correction, demo setup, favor), not the trader's
// own order flow (app/api/trade/orders/route.ts). Mirrors that route's
// lot-size validation and fill shape, but sources the fill price from
// LivePrice instead of trusting a client-supplied price (confirmed with
// the user) -- fat-fingering a price here would misprice a real
// account's position, unlike the trader route's existing "no live price
// authority yet" simplification which at least only ever affects the
// trader's own account.
export async function POST(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const accountId = typeof body?.accountId === "string" ? body.accountId : "";
  const symbolId = typeof body?.symbolId === "string" ? body.symbolId : "";
  const side = body?.side === "SELL" ? "SELL" : body?.side === "BUY" ? "BUY" : null;

  if (!accountId || !symbolId || !side) {
    return NextResponse.json({ error: "accountId, symbolId, and side are required" }, { status: 400 });
  }

  let volume: Prisma.Decimal;
  try {
    volume = new Prisma.Decimal(String(body?.volume ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid volume" }, { status: 400 });
  }
  if (!volume.gt(0)) {
    return NextResponse.json({ error: "volume must be positive" }, { status: 400 });
  }

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }
  if (account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account is not active" }, { status: 400 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId, symbolId, enabled: true },
    include: { symbol: true },
  });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol not available for this broker" }, { status: 400 });
  }
  if (volume.lt(brokerSymbol.minLot) || volume.gt(brokerSymbol.maxLot)) {
    return NextResponse.json(
      { error: `volume must be between ${brokerSymbol.minLot} and ${brokerSymbol.maxLot}` },
      { status: 400 }
    );
  }

  const price = await getFreshPrice(brokerSymbol.symbol.name);
  if (!price) {
    return NextResponse.json({ error: `no live price for ${brokerSymbol.symbol.name}` }, { status: 409 });
  }
  // BUY fills at ask, SELL fills at bid -- same convention as
  // engine/execution's execute_market_order.
  const fillPrice = side === "BUY" ? price.ask : price.bid;

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        brokerId,
        accountId,
        symbolId,
        side,
        type: "MARKET",
        volume,
        requestedPrice: fillPrice,
        idempotencyKey: `manual_${randomUUID()}`,
        status: "FILLED",
        filledPrice: fillPrice,
        filledAt: new Date(),
      },
    });
    const position = await tx.position.create({
      data: {
        brokerId,
        accountId,
        symbolId,
        originOrderId: order.id,
        side,
        volume,
        openPrice: fillPrice,
      },
    });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "MANUAL_POSITION_OPEN",
        entityType: "Position",
        entityId: position.id,
        newValue: {
          accountId,
          accountNumber: account.accountNumber,
          symbol: brokerSymbol.symbol.name,
          side,
          volume: volume.toString(),
          openPrice: fillPrice.toString(),
        },
      },
    });

    return { order, position };
  });

  return NextResponse.json({
    positionId: result.position.id,
    symbol: brokerSymbol.symbol.name,
    side,
    volume: volume.toString(),
    openPrice: fillPrice.toString(),
  });
}
