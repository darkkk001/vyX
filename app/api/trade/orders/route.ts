import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { validateSlTp } from "@/lib/trading";
import { createNotification } from "@/lib/notifications";
import { openPositionFromOrder } from "@/lib/dealing";
import { resolveBookType, applySpreadMarkup, resolveSymbolPricing, chargeCommission } from "@/lib/group-pricing";
import { checkAccountPreTradeMargin } from "@/lib/margin";
import { recordOrderAckLatency } from "@/lib/order-latency";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import * as mirror from "@/lib/mirror";
import { resolveWantsDealingQueue } from "@/lib/dealing-routing";
import { orderAuditFields } from "@/lib/order-audit";
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
  checkPriceFreshness,
  checkSlippage,
} from "@/lib/risk";

async function logHotkeyOrder(brokerId: string, orderId: string) {
  await prisma.auditLog.create({
    data: { brokerId, action: "STM_HOTKEY_ORDER", entityType: "Order", entityId: orderId, oldValue: {}, newValue: {} },
  });
}

// Phase 0 money-risk patch (docs/ROADMAP.md): the server is now the
// execution-price authority for MARKET orders. `price` in the request
// body is no longer what a MARKET order fills at -- it's the price the
// client saw when it clicked Buy/Sell, used only as a maxSlippage
// tolerance anchor (lib/risk.ts's checkSlippage) and as the SL/TP
// validation reference. The actual fill price is always this route's own
// fresh LivePrice read (checkPriceFreshness gates staleness at 3s) plus
// group markup, same as the dealing-mode branch below already did. LIMIT
// STOP orders still rest client-side until triggered, but their fill
// (app/api/trade/orders/[id]/fill/route.ts) applies this same
// server-price-authority rule, not the client's trigger-detected price.
//
// Phase 0 money-risk patch item 3 (docs/ROADMAP.md) -- this thin wrapper
// times the whole request end to end and records it as this broker's
// order-ack latency (lib/order-latency.ts) whenever handlePlaceOrder
// actually placed/filled/rejected an order (every such branch already
// returns 201; validation failures below it, e.g. bad volume, don't --
// those aren't a real "order ack", so they're deliberately excluded from
// the window). Separate from handlePlaceOrder itself so none of that
// function's many early-return branches needed touching individually.
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const response = await handlePlaceOrder(request);
  if (response.status === 201) {
    const session = await getAccountSession();
    if (session) {
      void recordOrderAckLatency(session.brokerId, Date.now() - startedAt).catch(() => {});
    }
  }
  return response;
}

async function handlePlaceOrder(request: NextRequest) {
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
  // Optional -- see lib/risk.ts's checkSlippage. WebTrader doesn't send
  // this today, so every order falls back to the default tolerance.
  const maxSlippagePips = body?.maxSlippagePips != null ? String(body.maxSlippagePips) : null;
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
    checkTradingSession(brokerSymbol.tradingSessions, new Date(), brokerSymbol.symbol.name) ??
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
  // Broker feedback (item 13) -- digits/stopLevel were never passed here,
  // so the minimum-distance-from-reference-price check inside validateSlTp
  // was silently a no-op for every order ever placed (MARKET or PENDING):
  // it only runs when both are non-null, and referencePrice is already
  // the ENTRY price for a PENDING order (the client-supplied `price`,
  // not a current tick), so this is genuinely "stopLevel relative to
  // entry" once wired -- exactly what was missing, not a new rule.
  const validationError = validateSlTp({ side, referencePrice: price, slPrice, tpPrice, digits: brokerSymbol.symbol.digits, stopLevel: brokerSymbol.stopLevel });
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
    const priceError = evaluateLiveMarketPrice(livePrice, symbolName, price) ?? checkPriceFreshness(livePrice);
    if (priceError) {
      return NextResponse.json({ error: priceError }, { status: 400 });
    }
  }

  // See lib/dealing-routing.ts's own doc comment -- Group.dealingMode can
  // override the four checks below entirely, in either direction.
  // `wantsQueue` doubles as the correct "is this account dealer-managed"
  // signal for the dealer-awareness feature below (recordDealerActivity's
  // isDealingGroup) -- NOT the raw groupTypeIsDealing flag alone, which a
  // group can be true for while still being AUTO/dealer-desk-off (see
  // lib/dealing-routing.ts's isDealingManagedAccount doc comment for the
  // 2026-09-04 bug this fixed).
  const wantsQueue = resolveWantsDealingQueue({
    groupDealingMode: account.group?.dealingMode ?? "INHERIT",
    brokerDealingModeOn: !!broker.dealingModeAt,
    groupForceDealingMode: !!account.group?.forceDealingMode,
    groupTypeIsDealing: account.group?.groupType === "DEALING",
    dealingDeskAutoFillOn: !!broker.dealingDeskAutoFillAt,
  });

  try {
    if (type === "MARKET" && wantsQueue) {
      // Dealing mode on -- broker-wide (Broker.dealingModeAt), this
      // account's own group opted in via the standalone toggle
      // (Group.forceDealingMode, e.g. a broker wants only a specific
      // group of accounts dealt manually regardless of book type), the
      // group's GroupType itself is DEALING (book-routing classification
      // -- a Dealing-book group's whole point is manual review before a
      // fill, so its orders must reach the queue even if nobody
      // separately flipped forceDealingMode on it too; without this, a
      // broker picking "Dealing" as the group's type got a group that was
      // functionally identical to a Demo/ungrouped one), OR the group's
      // own dealingMode is explicitly MANUAL. Queue for manual dealer
      // review instead of auto-filling. See app/api/manage/dealing-queue/*.
      // No Position yet; status stays PENDING (distinguishable from a
      // resting LIMIT/STOP order by `type`, so no new enum value needed).
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
      // Broker feedback items 14+15 -- placement itself is a lifecycle
      // event a dispute needs, independent of whatever the smart dealer
      // (or a human) decides next: this is the row that answers "what did
      // the client actually submit" (limit/stop price, SL, TP) before any
      // accept/reject/requote can change it.
      await prisma.auditLog.create({
        data: {
          brokerId: session.brokerId,
          action: "ORDER_PLACED",
          entityType: "Order",
          entityId: order.id,
          oldValue: {},
          newValue: {
            ...orderAuditFields(order, symbolName, account.accountNumber),
            requestedPrice: price,
            slPrice,
            tpPrice,
            status: "PENDING",
            queuedForDealing: true,
          },
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
          // Phase 0 money-risk patch (docs/ROADMAP.md item 2) -- an
          // auto-accept that would open a position the account can't
          // actually margin doesn't get to skip the gate just because
          // it's automated. Insufficient margin here doesn't reject the
          // order outright -- it falls through to the ordinary human
          // dealer queue below, same as a diffPct that simply didn't
          // clear the accept threshold.
          const marginError = await checkAccountPreTradeMargin(prisma, {
            accountId: session.accountId,
            leverage: account.leverage,
            marginCallLevel: account.group?.marginCallLevel ?? new Prisma.Decimal(100),
            newOrderContractSize: brokerSymbol.symbol.contractSize,
            newOrderVolume: volume,
            newOrderFillPrice: fillPrice,
          });
          if (!marginError) {
            const position = await prisma.$transaction(async (tx) => {
              const pos = await openPositionFromOrder(tx, order, fillPrice, bookType, pricing.commissionPerLot);
              await tx.auditLog.create({
                data: {
                  brokerId: session.brokerId,
                  action: "DEALING_ORDER_AUTO_ACCEPTED",
                  entityType: "Position",
                  entityId: pos.id,
                  oldValue: { ...orderAuditFields(order, symbolName, account.accountNumber), status: "PENDING", requestedPrice: price },
                  newValue: { status: "FILLED", filledPrice: fillPrice.toString(), diffPct: diffPct.toFixed(4) },
                },
              });
              return pos;
            });
            // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- Smart Dealer auto-accept
            // is a real fill, same as the direct MARKET-fill branch below,
            // but returns early before ever reaching that branch's own
            // hook -- this was the exact "mirror hook gap" this call was
            // missing.
            await mirror.onFillPosition(prisma, position, brokerSymbol.symbol.name).catch((err) => console.error("mirror.onFill failed", err));
            await publishTradingEvent("OrderFilled", {
              order_id: order.id,
              account_id: session.accountId,
              broker_id: session.brokerId,
              price: fillPrice.toString(),
              volume: volume.toString(),
              remaining_volume: "0",
            });
            await recordDealerActivity(prisma, {
              brokerId: session.brokerId,
              accountId: session.accountId,
              accountNumber: account.accountNumber,
              accountFullName: account.fullName,
              isDealingGroup: wantsQueue,
              action: "POSITION_OPENED",
              symbol: symbolName,
              side,
              volume: volume.toString(),
              values: { openPrice: fillPrice.toString(), origin: "smart_dealer_auto_accept" },
              orderId: order.id,
              positionId: position.id,
            });
            // `position`, not `positionId` -- must match the direct-fill
            // branch's shape below (and lib/trade-api.ts's placeOrder type)
            // exactly. This mismatch previously meant a Smart-Dealer
            // auto-accepted order (a real, immediate fill) showed the
            // client its "awaiting dealer approval" toast instead of the
            // fill confirmation, and skipped the orderFilled sound.
            return NextResponse.json({ order: { ...order, status: "FILLED", filledPrice: fillPrice }, position: { id: position.id } }, { status: 201 });
          }
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
                oldValue: { ...orderAuditFields(order, symbolName, account.accountNumber), status: "PENDING", requestedPrice: price },
                newValue: { status: "REJECTED", reason, diffPct: diffPct.toFixed(4) },
              },
            });
            return o;
          });
          await publishTradingEvent("OrderRejected", {
            order_id: order.id,
            account_id: session.accountId,
            broker_id: session.brokerId,
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
        body: `${account.accountNumber}, ${side} ${volume.toString()} ${symbolName}`,
        entityType: "Order",
        entityId: order.id,
      });
      await publishTradingEvent("OrderAccepted", { order_id: order.id, account_id: session.accountId, broker_id: session.brokerId });
      // Backoffice-facing signal, distinct from OrderAccepted (which the
      // trader's own WebTrader listens for) -- carries the row shape
      // app/manage/(shell)/dealing/DealingQueueManager.tsx needs so a new
      // queue entry can be applied straight to that component's local
      // rows state instead of waiting for a refetch (see
      // services/api-gateway/src/ws.ts's attachAdminEventStream).
      await publishTradingEvent("DealingQueued", {
        order_id: order.id,
        broker_id: session.brokerId,
        account_id: session.accountId,
        account_number: account.accountNumber,
        account_full_name: account.fullName,
        symbol: symbolName,
        digits: brokerSymbol.symbol.digits,
        side,
        volume: volume.toString(),
        requested_price: price,
        created_at: order.createdAt.toISOString(),
        // Same livePrice this function already fetched above to validate
        // the order itself -- included so the backoffice can render a
        // usable row (Accept's price field is pre-filled from this)
        // straight from the event, without a second round trip just to
        // learn the live price.
        live_bid: livePrice?.bid.toString() ?? null,
        live_ask: livePrice?.ask.toString() ?? null,
      });
      await recordDealerActivity(prisma, {
        brokerId: session.brokerId,
        accountId: session.accountId,
        accountNumber: account.accountNumber,
        accountFullName: account.fullName,
        isDealingGroup: wantsQueue,
        action: "ORDER_PLACED",
        symbol: symbolName,
        side,
        volume: volume.toString(),
        values: { requestedPrice: price, slPrice, tpPrice, queuedForDealing: true },
        orderId: order.id,
        skipNotification: true, // DEALING_ORDER_PENDING notification already fired above
      });
      return NextResponse.json({ order }, { status: 201 });
    }

    if (type === "MARKET") {
      // Server-price-authority fill (Phase 0, see this route's module
      // comment) -- base is this route's own fresh LivePrice read
      // (already validated for staleness above), not the client's
      // submitted `price`. requestedPrice keeps the client's original
      // reference so the audit trail still shows what the client expected.
      const pricing = await resolveSymbolPricing(prisma, {
        groupId: account.groupId,
        symbolId: brokerSymbol.symbolId,
        brokerSpreadMarkup: brokerSymbol.spreadMarkup,
        brokerCommissionPerLot: brokerSymbol.commissionPerLot,
      });
      const serverRef = side === "BUY" ? livePrice!.ask : livePrice!.bid;
      const fillPrice = applySpreadMarkup({ side, price: serverRef, spreadMarkup: pricing.spreadMarkup, digits: brokerSymbol.symbol.digits });
      const slippageError = checkSlippage({
        clientReferencePrice: price,
        serverFillPrice: fillPrice,
        maxSlippagePips,
        digits: brokerSymbol.symbol.digits,
      });
      if (slippageError) {
        return NextResponse.json({ error: slippageError }, { status: 400 });
      }
      // Phase 0 money-risk patch (docs/ROADMAP.md item 2) -- pre-trade
      // margin gate, same rule engine/risk/src/lib.rs's check_free_margin
      // already enforces on the Rust path (lib/margin.ts's
      // checkPreTradeMargin/lib/margin.test.ts). Rejects before any
      // Order/Position row is written -- unlike the smart-dealer branch
      // above, there's no "fall through to a human" option here, so an
      // insufficient-margin order is rejected outright with the actual
      // numbers so WebTrader can show a real message.
      const marginError = await checkAccountPreTradeMargin(prisma, {
        accountId: session.accountId,
        leverage: account.leverage,
        marginCallLevel: account.group?.marginCallLevel ?? new Prisma.Decimal(100),
        newOrderContractSize: brokerSymbol.symbol.contractSize,
        newOrderVolume: volume,
        newOrderFillPrice: fillPrice,
      });
      if (marginError) {
        return NextResponse.json(marginError, { status: 400 });
      }
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
        // Broker feedback items 14+15 -- the highest-volume fill path in
        // the app (immediate MARKET fill, no dealing queue involved) had
        // no audit row at all; "requested vs filled" is exactly what a
        // dispute over slippage/price needs.
        await tx.auditLog.create({
          data: {
            brokerId: session.brokerId,
            action: "ORDER_FILLED",
            entityType: "Position",
            entityId: position.id,
            oldValue: { ...orderAuditFields(order, symbolName, account.accountNumber), requestedPrice: price, slPrice, tpPrice, status: "PENDING" },
            newValue: { status: "FILLED", filledPrice: fillPrice.toString() },
          },
        });
        return { order, position };
      });
      // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- called after this route's own
      // transaction has committed, never inside it: a mirror failure
      // (margin, market closed, kill switch) must never roll back or
      // block the client's own fill. lib/mirror.ts's onFill never throws,
      // but the extra catch here is a deliberate second guarantee for a
      // money-moving hook on the highest-volume order path in the app.
      await mirror.onFillPosition(prisma, result.position, brokerSymbol.symbol.name).catch((err) => console.error("mirror.onFill failed", err));
      if (source === "hotkey") await logHotkeyOrder(session.brokerId, result.order.id);
      await publishTradingEvent("OrderFilled", {
        order_id: result.order.id,
        account_id: session.accountId,
        broker_id: session.brokerId,
        price: result.order.filledPrice?.toString() ?? price,
        volume: volume.toString(),
        remaining_volume: "0",
      });
      await recordDealerActivity(prisma, {
        brokerId: session.brokerId,
        accountId: session.accountId,
        accountNumber: account.accountNumber,
        accountFullName: account.fullName,
        isDealingGroup: wantsQueue,
        action: "POSITION_OPENED",
        symbol: symbolName,
        side,
        volume: volume.toString(),
        values: { openPrice: result.order.filledPrice?.toString() ?? price, origin: "market" },
        orderId: result.order.id,
        positionId: result.position.id,
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
    // Broker feedback items 14+15 -- a resting LIMIT/STOP order (the
    // common "pending order" case) had no placement audit row at all;
    // this is what lets a broker later answer "what limit/SL/TP did the
    // client actually set" without needing the order to still exist.
    await prisma.auditLog.create({
      data: {
        brokerId: session.brokerId,
        action: "ORDER_PLACED",
        entityType: "Order",
        entityId: order.id,
        oldValue: {},
        newValue: {
          ...orderAuditFields(order, symbolName, account.accountNumber),
          requestedPrice: price,
          slPrice,
          tpPrice,
          status: "PENDING",
        },
      },
    });
    if (source === "hotkey") await logHotkeyOrder(session.brokerId, order.id);
    await publishTradingEvent("OrderAccepted", { order_id: order.id, account_id: session.accountId, broker_id: session.brokerId });
    await recordDealerActivity(prisma, {
      brokerId: session.brokerId,
      accountId: session.accountId,
      accountNumber: account.accountNumber,
      accountFullName: account.fullName,
      isDealingGroup: wantsQueue,
      action: "ORDER_PLACED",
      symbol: symbolName,
      side,
      volume: volume.toString(),
      values: { requestedPrice: price, triggerPrice: price, slPrice, tpPrice, orderType: type },
      orderId: order.id,
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
