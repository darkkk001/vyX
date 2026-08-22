import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { validateSlTp } from "@/lib/trading";
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
// lot-size validation and fill shape. `price` is optional: an explicit
// admin-typed price fills at exactly that value (confirmed with the
// user -- a dealer correcting a phone order often needs the trade
// booked at the price actually agreed with the client, not whatever
// the feed shows right now); omitting it falls back to the live
// LivePrice tick, same as before this was configurable.
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
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;

  if (!accountId || !symbolId || !side) {
    return NextResponse.json({ error: "accountId, symbolId, and side are required" }, { status: 400 });
  }

  // Optional -- see this route's own doc comment. A blank/missing value
  // means "use the live tick", same as before this was ever configurable.
  let explicitPrice: Prisma.Decimal | null = null;
  if (body?.price != null && String(body.price).trim() !== "") {
    try {
      explicitPrice = new Prisma.Decimal(String(body.price));
    } catch {
      return NextResponse.json({ error: "invalid price" }, { status: 400 });
    }
    if (explicitPrice.lte(0)) {
      return NextResponse.json({ error: "price must be positive" }, { status: 400 });
    }
  }
  let slPrice: Prisma.Decimal | null = null;
  if (body?.slPrice != null && String(body.slPrice).trim() !== "") {
    try {
      slPrice = new Prisma.Decimal(String(body.slPrice));
    } catch {
      return NextResponse.json({ error: "invalid slPrice" }, { status: 400 });
    }
  }
  let tpPrice: Prisma.Decimal | null = null;
  if (body?.tpPrice != null && String(body.tpPrice).trim() !== "") {
    try {
      tpPrice = new Prisma.Decimal(String(body.tpPrice));
    } catch {
      return NextResponse.json({ error: "invalid tpPrice" }, { status: 400 });
    }
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

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } },
  });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }
  if (account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account is not active" }, { status: 400 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId, symbolId, enabled: true },
    include: { symbol: true, tradingSessions: true },
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

  // Risk checks -- see lib/risk.ts. Same checks and order as the
  // trader-facing route (app/api/trade/orders/route.ts) -- a manual
  // dealing-desk open must respect the same broker/symbol/account
  // policies as a trader's own order.
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
  const riskError =
    checkTradingHalted(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, side) ??
    checkTradingSession(brokerSymbol.tradingSessions, new Date()) ??
    checkLotStep(volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
    (account.group ? checkGroupMaxLot(volume, account.group.maxLotSize) : null) ??
    (account.group ? checkGroupTradingRestriction(account.group.tradingRestriction, side) : null) ??
    (account.group
      ? checkGroupAllowedSymbol(
          account.group.restrictSymbols,
          account.group.allowedSymbols.map((s) => s.symbolId),
          brokerSymbol.symbolId
        )
      : null) ??
    (await checkMaxOpenPositions(prisma, accountId, broker.maxOpenPositionsPerAccount)) ??
    (await checkSymbolExposure(prisma, accountId, symbolId, volume, brokerSymbol.maxExposure)) ??
    (await checkBrokerExposure(prisma, brokerId, volume, broker.totalExposureLimit)) ??
    (await checkMaxDailyLoss(prisma, accountId, account.maxDailyLoss));
  if (riskError) {
    return NextResponse.json({ error: riskError }, { status: 400 });
  }

  let fillPrice: Prisma.Decimal;
  if (explicitPrice) {
    fillPrice = explicitPrice;
  } else {
    const price = await getFreshPrice(brokerSymbol.symbol.name);
    if (!price) {
      return NextResponse.json({ error: `no live price for ${brokerSymbol.symbol.name} -- type a price to open anyway` }, { status: 409 });
    }
    // BUY fills at ask, SELL fills at bid -- same convention as
    // engine/execution's execute_market_order.
    fillPrice = side === "BUY" ? price.ask : price.bid;
  }

  const slTpError = validateSlTp({ side, referencePrice: fillPrice, slPrice, tpPrice });
  if (slTpError) {
    return NextResponse.json({ error: slTpError }, { status: 400 });
  }

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
        slPrice,
        tpPrice,
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
        slPrice,
        tpPrice,
        bookType: brokerSymbol.defaultBookType,
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
          // Optional dealing-desk reason, e.g. "Phone order -- client
          // unable to access platform" -- no schema field for it, so it
          // rides along in the AuditLog row rather than the Position/Order
          // itself, same as every other admin-action reason in this app.
          ...(note ? { note } : {}),
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
