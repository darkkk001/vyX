import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { validateSlTp } from "@/lib/trading";
import { createNotification } from "@/lib/notifications";
import { openPositionFromOrder } from "@/lib/dealing";
import { resolveBookType, applySpreadMarkup, resolveSymbolPricing, chargeCommission } from "@/lib/group-pricing";
import { publishTradingEvent } from "@/lib/nats";
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
  evaluateLiveMarketPrice,
} from "@/lib/risk";

async function logHotkeyOrder(brokerId: string, orderId: string) {
  await prisma.auditLog.create({
    data: { brokerId, action: "STM_HOTKEY_ORDER", entityType: "Order", entityId: orderId, oldValue: {}, newValue: {} },
  });
}

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
  // Optional, client-asserted, informational only -- doesn't change
  // validation/risk/execution at all (every branch below runs identically
  // regardless), just which of this route's several success points also
  // writes an STM_HOTKEY_ORDER audit row. See
  // docs/webtrader-stm-architecture-review.md §4.6 and
  // components/webtrader/SmartTradeManager.tsx's smartExecute.
  const source = body?.source === "hotkey" ? "hotkey" : null;

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
    include: { symbol: true, tradingSessions: true },
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
    prisma.account.findUniqueOrThrow({
      where: { id: session.accountId },
      include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } },
    }),
  ]);
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
  // used to only check that *a* tick existed, not that this price was
  // anywhere near it — meaning a fresh tick for the symbol was enough
  // cover to open at literally any price, then close near the real price
  // later (see lib/risk.ts's checkLiveMarketPrice, added after that close
  // half of the same exploit was fixed) to mint the difference as profit.
  // evaluateLiveMarketPrice now floors both halves the same way. PENDING
  // (LIMIT/STOP) orders aren't checked here — they rest until a real tick
  // triggers a fill via the separate fill endpoint, which runs this same
  // check itself.
  let livePrice: Awaited<ReturnType<typeof prisma.livePrice.findUnique>> = null;
  if (type === "MARKET") {
    livePrice = await prisma.livePrice.findUnique({ where: { symbol: symbolName } });
    const priceError = evaluateLiveMarketPrice(livePrice, symbolName, price);
    if (priceError) {
      return NextResponse.json({ error: priceError }, { status: 400 });
    }
  }

  try {
    if (
      type === "MARKET" &&
      (broker.dealingModeAt || account.group?.forceDealingMode || account.group?.groupType === "DEALING")
    ) {
      // Dealing mode on -- broker-wide (Broker.dealingModeAt), this
      // account's own group opted in via the standalone toggle
      // (Group.forceDealingMode, e.g. a broker wants only a specific
      // group of accounts dealt manually regardless of book type), OR
      // the group's GroupType itself is DEALING (book-routing
      // classification -- a Dealing-book group's whole point is manual
      // review before a fill, so its orders must reach the queue even
      // if nobody separately flipped forceDealingMode on it too; without
      // this, a broker picking "Dealing" as the group's type got a group
      // that was functionally identical to a Demo/ungrouped one). Queue
      // for manual dealer review instead of auto-filling. See
      // app/api/manage/dealing-queue/*. No Position yet; status stays
      // PENDING (distinguishable from a resting LIMIT/STOP order by
      // `type`, so no new enum value needed).
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
      if (source === "hotkey") await logHotkeyOrder(session.brokerId, order.id);

      // Smart Dealer -- see Broker.smartDealerAcceptPct/RejectPct's
      // schema comments. Evaluated once, right here, at submission --
      // there's no cron/poller anywhere in this app to re-evaluate an
      // order already sitting in the queue.
      if (livePrice && (broker.smartDealerAcceptPct != null || broker.smartDealerRejectPct != null)) {
        const liveRef = side === "BUY" ? livePrice.ask : livePrice.bid;
        const requested = new Prisma.Decimal(price);
        const diffPct = liveRef.sub(requested).abs().div(requested).mul(100);

        if (broker.smartDealerAcceptPct != null && diffPct.lte(broker.smartDealerAcceptPct)) {
          // diffPct above stays computed against the raw liveRef (how far
          // the market moved from what the client asked) -- spread markup
          // is a separate, broker-revenue adjustment applied only to the
          // actual fill price, not to the accept/reject threshold check.
          const pricing = await resolveSymbolPricing(prisma, {
            groupId: account.groupId,
            symbolId: brokerSymbol.symbolId,
            brokerSpreadMarkup: brokerSymbol.spreadMarkup,
            brokerCommissionPerLot: brokerSymbol.commissionPerLot,
          });
          const fillPrice = applySpreadMarkup({ side, price: liveRef, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits });
          const bookType = account.group ? resolveBookType(account.group.groupType) : brokerSymbol.defaultBookType;
          const position = await prisma.$transaction(async (tx) => {
            const pos = await openPositionFromOrder(tx, order, fillPrice, bookType, pricing.commissionPerLot);
            await tx.auditLog.create({
              data: {
                brokerId: session.brokerId,
                action: "DEALING_ORDER_AUTO_ACCEPTED",
                entityType: "Position",
                entityId: pos.id,
                oldValue: { status: "PENDING", requestedPrice: price },
                newValue: { status: "FILLED", filledPrice: fillPrice.toString(), diffPct: diffPct.toFixed(4) },
              },
            });
            return pos;
          });
          await publishTradingEvent("OrderFilled", {
            order_id: order.id,
            account_id: session.accountId,
            price: fillPrice.toString(),
            volume: volume.toString(),
            remaining_volume: "0",
          });
          return NextResponse.json({ order: { ...order, status: "FILLED", filledPrice: fillPrice }, positionId: position.id }, { status: 201 });
        }

        if (broker.smartDealerRejectPct != null && diffPct.gte(broker.smartDealerRejectPct)) {
          const reason = "price moved beyond broker tolerance (auto-rejected)";
          const rejected = await prisma.$transaction(async (tx) => {
            const o = await tx.order.update({ where: { id: order.id }, data: { status: "REJECTED", rejectionReason: reason } });
            await tx.auditLog.create({
              data: {
                brokerId: session.brokerId,
                action: "DEALING_ORDER_AUTO_REJECTED",
                entityType: "Order",
                entityId: order.id,
                oldValue: { status: "PENDING", requestedPrice: price },
                newValue: { status: "REJECTED", reason, diffPct: diffPct.toFixed(4) },
              },
            });
            return o;
          });
          await publishTradingEvent("OrderRejected", {
            order_id: order.id,
            account_id: session.accountId,
            reason,
          });
          return NextResponse.json({ order: rejected }, { status: 201 });
        }
      }

      // Neither Smart Dealer threshold fired (or it's off) -- queue for
      // a human as before.
      await createNotification(prisma, {
        brokerId: session.brokerId,
        type: "DEALING_ORDER_PENDING",
        title: "Order awaiting dealer review",
        body: `${account.accountNumber} — ${side} ${volume.toString()} ${symbolName}`,
        entityType: "Order",
        entityId: order.id,
      });
      await publishTradingEvent("OrderAccepted", { order_id: order.id, account_id: session.accountId });
      return NextResponse.json({ order }, { status: 201 });
    }

    if (type === "MARKET") {
      // See lib/group-pricing.ts's own comments on why this stays a
      // post-hoc adjustment to whatever price fills the order (here, the
      // client's own supplied price -- see this route's module doc
      // comment on why the server isn't the price authority for this
      // path yet) rather than something computed inside price quoting.
      // requestedPrice keeps the client's original, unmarked-up ask.
      const pricing = await resolveSymbolPricing(prisma, {
        groupId: account.groupId,
        symbolId: brokerSymbol.symbolId,
        brokerSpreadMarkup: brokerSymbol.spreadMarkup,
        brokerCommissionPerLot: brokerSymbol.commissionPerLot,
      });
      const fillPrice = applySpreadMarkup({ side, price, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits });
      const bookType = account.group ? resolveBookType(account.group.groupType) : brokerSymbol.defaultBookType;
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
            filledPrice: fillPrice,
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
            openPrice: fillPrice,
            slPrice,
            tpPrice,
            bookType,
          },
        });
        await chargeCommission(tx, { brokerId: session.brokerId, accountId: session.accountId, positionId: position.id, commissionPerLot: pricing.commissionPerLot, volume });
        return { order, position };
      });
      if (source === "hotkey") await logHotkeyOrder(session.brokerId, result.order.id);
      await publishTradingEvent("OrderFilled", {
        order_id: result.order.id,
        account_id: session.accountId,
        price: result.order.filledPrice?.toString() ?? price,
        volume: volume.toString(),
        remaining_volume: "0",
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
    if (source === "hotkey") await logHotkeyOrder(session.brokerId, order.id);
    await publishTradingEvent("OrderAccepted", { order_id: order.id, account_id: session.accountId });
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

// Default: only PENDING/REQUOTED (what's actually still resting/awaiting
// a response) -- the "Pending Orders" tab. ?status=all drops that filter
// for full order-lifecycle visibility (also FILLED/REJECTED/CANCELLED) --
// the separate "Orders" tab (docs/webtrader-stm-architecture-review.md
// §4.5). Same query shape either way, no new endpoint needed.
export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const showAll = new URL(request.url).searchParams.get("status") === "all";

  const orders = await prisma.order.findMany({
    where: {
      accountId: session.accountId,
      ...(showAll ? {} : { status: { in: ["PENDING", "REQUOTED"] } }),
    },
    include: { symbol: { select: { name: true, digits: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(orders);
}
