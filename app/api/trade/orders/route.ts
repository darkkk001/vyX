import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { validateSlTp } from "@/lib/trading";
import {
  checkTradingHalted,
  checkSymbolTradingMode,
  checkLotStep,
  checkMaxOpenPositions,
  checkSymbolExposure,
  checkBrokerExposure,
  checkMaxDailyLoss,
} from "@/lib/risk";

// Phase 2 note: there is no live tick feed or matching engine yet (that's
// Phase 5). Prices are simulated client-side, so the client supplies the
// price it wants to transact at, and MARKET orders fill immediately at
// that price. This is a deliberate, temporary simplification — real order
// matching against a broker-fed price stream replaces this wholesale in
// Phase 5, at which point the server (not the client) becomes the price
// authority.
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const symbolName = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = body?.side === "SELL" ? "SELL" : body?.side === "BUY" ? "BUY" : null;
  const type = ["MARKET", "LIMIT", "STOP"].includes(body?.type) ? body.type : null;
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const price = body?.price != null ? String(body.price) : null;
  const slPrice = body?.slPrice != null ? String(body.slPrice) : null;
  const tpPrice = body?.tpPrice != null ? String(body.tpPrice) : null;

  if (!symbolName || !side || !type || !idempotencyKey) {
    return NextResponse.json(
      { error: "symbol, side, type, and idempotencyKey are required" },
      { status: 400 }
    );
  }

  // Idempotency: a duplicated submission (retry, double-click) returns the
  // already-created order instead of creating a second one.
  const existing = await prisma.order.findUnique({
    where: { accountId_idempotencyKey: { accountId: session.accountId, idempotencyKey } },
  });
  if (existing) {
    return NextResponse.json(existing, { status: 200 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId: session.brokerId, enabled: true, symbol: { name: symbolName } },
    include: { symbol: true },
  });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol not available for this broker" }, { status: 400 });
  }

  let volume: Prisma.Decimal;
  try {
    volume = new Prisma.Decimal(String(body?.volume ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid volume" }, { status: 400 });
  }
  if (volume.lt(brokerSymbol.minLot) || volume.gt(brokerSymbol.maxLot)) {
    return NextResponse.json(
      { error: `volume must be between ${brokerSymbol.minLot} and ${brokerSymbol.maxLot}` },
      { status: 400 }
    );
  }

  // Risk checks -- see lib/risk.ts. Cheap/synchronous first, then the
  // query-backed ones, all before any order/position is created.
  const [broker, account] = await Promise.all([
    prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId } }),
    prisma.account.findUniqueOrThrow({ where: { id: session.accountId } }),
  ]);
  const riskError =
    checkTradingHalted(broker) ??
    checkSymbolTradingMode(brokerSymbol.tradingMode, side) ??
    checkLotStep(volume, brokerSymbol.minLot, brokerSymbol.lotStep) ??
    (await checkMaxOpenPositions(prisma, session.accountId, broker.maxOpenPositionsPerAccount)) ??
    (await checkSymbolExposure(prisma, session.accountId, brokerSymbol.symbolId, volume, brokerSymbol.maxExposure)) ??
    (await checkBrokerExposure(prisma, session.brokerId, volume, broker.totalExposureLimit)) ??
    (await checkMaxDailyLoss(prisma, session.accountId, account.maxDailyLoss));
  if (riskError) {
    return NextResponse.json({ error: riskError }, { status: 400 });
  }

  if (!price) {
    return NextResponse.json({ error: "price is required" }, { status: 400 });
  }
  const validationError = validateSlTp({ side, referencePrice: price, slPrice, tpPrice });
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  // MARKET orders fill immediately, so the client-supplied price must be
  // backed by a real, fresh tick — not the client's own random-walk
  // fallback (see lib/market-simulator.ts's `live` flag, which the client
  // UI already uses to disable Buy/Sell for a symbol with no feed). This
  // is a server-side floor for that same rule, since client-side
  // disabling alone doesn't stop a direct API call. Same 15s staleness
  // window used everywhere else in this codebase (Rust engine's
  // TickCache/get_live_price, and WebTrader's own liveTicksRef filter).
  // PENDING (LIMIT/STOP) orders aren't checked here — they rest until a
  // real tick triggers a fill via the separate fill endpoint.
  if (type === "MARKET") {
    const livePrice = await prisma.livePrice.findUnique({ where: { symbol: symbolName } });
    if (!livePrice || Date.now() - livePrice.updatedAt.getTime() > 15_000) {
      return NextResponse.json({ error: "no live feed for this symbol" }, { status: 400 });
    }
  }

  try {
    if (type === "MARKET" && broker.dealingModeAt) {
      // Dealing mode on: queue for manual dealer review instead of
      // auto-filling -- see app/api/manage/dealing-queue/*. No Position
      // yet; status stays PENDING (distinguishable from a resting
      // LIMIT/STOP order by `type`, so no new enum value needed).
      const order = await prisma.order.create({
        data: {
          brokerId: session.brokerId,
          accountId: session.accountId,
          symbolId: brokerSymbol.symbolId,
          side,
          type,
          volume,
          requestedPrice: price,
          slPrice,
          tpPrice,
          idempotencyKey,
          status: "PENDING",
        },
      });
      return NextResponse.json({ order }, { status: 201 });
    }

    if (type === "MARKET") {
      const result = await prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            brokerId: session.brokerId,
            accountId: session.accountId,
            symbolId: brokerSymbol.symbolId,
            side,
            type,
            volume,
            requestedPrice: price,
            slPrice,
            tpPrice,
            idempotencyKey,
            status: "FILLED",
            filledPrice: price,
            filledAt: new Date(),
          },
        });
        const position = await tx.position.create({
          data: {
            brokerId: session.brokerId,
            accountId: session.accountId,
            symbolId: brokerSymbol.symbolId,
            originOrderId: order.id,
            side,
            volume,
            openPrice: price,
            slPrice,
            tpPrice,
          },
        });
        return { order, position };
      });
      return NextResponse.json(result, { status: 201 });
    }

    // LIMIT / STOP: rests as a PENDING order until the client's local price
    // simulation reports the trigger price is hit, then calls the fill
    // endpoint.
    const order = await prisma.order.create({
      data: {
        brokerId: session.brokerId,
        accountId: session.accountId,
        symbolId: brokerSymbol.symbolId,
        side,
        type,
        volume,
        requestedPrice: price,
        slPrice,
        tpPrice,
        idempotencyKey,
        status: "PENDING",
      },
    });
    return NextResponse.json(order, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.order.findUnique({
        where: { accountId_idempotencyKey: { accountId: session.accountId, idempotencyKey } },
      });
      if (raced) return NextResponse.json(raced, { status: 200 });
    }
    throw error;
  }
}

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const orders = await prisma.order.findMany({
    where: { accountId: session.accountId, status: "PENDING" },
    include: { symbol: { select: { name: true, digits: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(orders);
}
