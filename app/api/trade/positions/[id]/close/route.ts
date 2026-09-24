import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { closePositionInTx } from "@/lib/position-close";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { isDealingManagedAccount } from "@/lib/dealing-routing";
import { checkLotStep, checkPriceFreshness, checkSlippage, checkTradingSession, computeNextSessionOpen, evaluateLiveMarketPrice } from "@/lib/risk";
import { closePriceFor } from "@/lib/trading";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";
import { classifyMissingPrice, getLivePriceRow } from "@/lib/live-price";
import { accountWantsDealingQueue, afterCloseQueued, queueCloseInTx, ClosePendingError } from "@/lib/queued-close";

// Closing (fully or partially) is the one place a trade changes the
// account balance. Realized P&L is computed server-side and applied
// atomically alongside a ledger Transaction row — never a silent balance
// overwrite. A partial close (volume < position.volume) reduces the
// position's volume and keeps it OPEN rather than closing it outright;
// the Transaction row is still the authoritative record of what was
// realized and when.
//
// Server price authority (2026-09-18, money-mint hole closed): the close
// fills at THIS route's own fresh live price for the position's side --
// closePriceFor: a BUY is sold at bid, a SELL bought at ask -- exactly as
// app/api/trade/orders/route.ts's MARKET fill, lib/bulk-close.ts and
// lib/risk-monitor.ts already do. The client's `closePrice` is only its
// reference: sanity-checked against the market (evaluateLiveMarketPrice)
// and used as the slippage anchor (checkSlippage, same tolerance chain as
// the open path), never as the price the P&L is computed from. Before this
// the body's closePrice went straight into closePositionInTx: anything
// within the 2% deviation band was accepted as the fill, side ignored, so
// a client could close a 1-lot XAUUSD BUY at mid + 1.9% and have the
// difference credited to its balance, every 15 s, for as long as a fresh
// tick existed.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  // The client's reference price -- what it saw when it clicked (bid for a
  // BUY, ask for a SELL). Required so every close has a slippage anchor and
  // an audit trail of what the client expected; NOT the fill price.
  const clientReferencePrice = body?.closePrice != null ? String(body.closePrice) : null;
  if (!clientReferencePrice) {
    return NextResponse.json({ error: "closePrice is required" }, { status: 400 });
  }
  // Optional, same contract as the open path (lib/risk.ts's checkSlippage):
  // the native terminal sends its SLIPPAGE MAX ("unlimited" for "M"),
  // WebTrader sends "unlimited" too; nothing sent = the broker default if set, else unlimited.
  const maxSlippagePips = body?.maxSlippagePips != null ? String(body.maxSlippagePips) : null;
  // Informational only, doesn't change validation/execution -- flags this
  // close for the STM_BULK_CLOSE audit trail. See
  // components/webtrader/SmartTradeManager.tsx's runBulk/partialCloseOne/
  // closeOne and docs/webtrader-stm-architecture-review.md §4.6.
  const source = body?.source === "stm_bulk" ? "stm_bulk" : null;

  const position = await prisma.position.findUnique({
    where: { id },
    include: {
      symbol: { select: { id: true, name: true, category: true, contractSize: true, digits: true } },
      account: { select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } } },
    },
  });
  if (!position || position.accountId !== session.accountId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }
  // Closes respect DEALER mode (docs/CLOSES-RESPECT-DEALER-MODE.md): a close already awaiting
  // the dealer locks the position -- a second one is refused with the pending order, so the
  // client can show / cancel it rather than pile up requests.
  if (position.closePendingOrderId) {
    return NextResponse.json({ error: "CLOSE_PENDING", orderId: position.closePendingOrderId }, { status: 409 });
  }

  // Real bug fixed here (2026-09-05): this route never checked whether the
  // symbol's market was actually open at all -- a close outside trading
  // hours fell straight through to checkLiveMarketPrice below, which (with
  // no fresh LivePrice tick, since nothing feeds a closed market) always
  // rejected as "no live feed", so a trader reading that message thought
  // the system was broken rather than the market being routinely closed
  // (e.g. every weekend). checkTradingSession now runs first and returns
  // the real reason -- MARKET_CLOSED with the actual next-open time from
  // this symbol's own TradingSession config -- distinguishing it from a
  // genuine feed outage (market OPEN, feed down), which is what
  // checkLiveMarketPrice below still guards, now correctly scoped to only
  // that rarer case.
  const brokerSymbol = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId: session.brokerId, symbolId: position.symbol.id } },
    include: { tradingSessions: true },
  });
  const sessionError = checkTradingSession(brokerSymbol?.tradingSessions ?? [], new Date(), position.symbol.category);
  if (sessionError) {
    const nextOpenAt = computeNextSessionOpen(brokerSymbol?.tradingSessions ?? [], new Date(), position.symbol.category);
    return NextResponse.json({ error: sessionError, nextOpenAt: nextOpenAt.toISOString() }, { status: 400 });
  }

  // S4 (docs/market-data.md §8): the engine's own in-memory tick when
  // MARKET_DATA_PRICES=vps, Neon otherwise. evaluateLiveMarketPrice keeps the
  // client's reference honest (NO_LIVE_FEED / too far from market) and
  // checkPriceFreshness gates staleness at the fill threshold, both exactly
  // as the open path does. The fill price itself is derived below from this
  // read and nothing else.
  const livePrice = await getLivePriceRow(position.symbol.name);
  const priceError = evaluateLiveMarketPrice(livePrice, position.symbol.name, clientReferencePrice) ?? checkPriceFreshness(livePrice);
  if (priceError || !livePrice) {
    const code = priceError ?? "NO_LIVE_FEED";
    // schedule OPEN but no fresh tick: feed alive elsewhere = this market is not quoting (see classifyMissingPrice)
    if ((code === "NO_LIVE_FEED" || code === "PRICE_STALE") && (await classifyMissingPrice(session.brokerId, position.symbol.name)) === "MARKET_CLOSED") {
      return NextResponse.json({ error: "MARKET_CLOSED", reason: "NOT_QUOTING", nextOpenAt: null, symbol: position.symbol.name, lastTickAt: livePrice?.tickAt?.toISOString() ?? null }, { status: 400 });
    }
    return NextResponse.json({ error: code, symbol: position.symbol.name, lastTickAt: livePrice?.tickAt?.toISOString() ?? null }, { status: 400 });
  }
  const closePrice = closePriceFor(position.side, livePrice.bid, livePrice.ask);

  let closeVolume = position.volume;
  if (body?.volume != null) {
    let requested: Prisma.Decimal;
    try {
      requested = new Prisma.Decimal(String(body.volume));
    } catch {
      return NextResponse.json({ error: "invalid volume" }, { status: 400 });
    }
    if (requested.lte(0) || requested.gt(position.volume)) {
      return NextResponse.json(
        { error: `volume must be between 0 and ${position.volume}` },
        { status: 400 }
      );
    }
    // Partial close (item 9 of the terminal live-findings pack) -- a
    // partial amount that isn't itself a tradeable lot size (or that
    // leaves a dangling remainder that isn't) was previously accepted
    // outright; nothing here ever checked it, unlike order creation's
    // own checkLotStep gate. A full close (requested === position.volume)
    // skips this -- there's no remainder to be invalid, and a position
    // opened before minLot/lotStep were configured (or before they
    // changed) must always still be fully closeable.
    if (!requested.equals(position.volume)) {
      if (brokerSymbol) {
        const stepError = checkLotStep(requested, brokerSymbol.minLot, brokerSymbol.lotStep);
        if (stepError) {
          return NextResponse.json({ error: `partial close amount ${stepError}` }, { status: 400 });
        }
        const remaining = position.volume.sub(requested);
        if (remaining.gt(0) && remaining.lt(brokerSymbol.minLot)) {
          return NextResponse.json(
            { error: `closing this amount would leave ${remaining} lots open, below this symbol's minimum of ${brokerSymbol.minLot}. Close the full position instead` },
            { status: 400 }
          );
        }
      }
    }
    closeVolume = requested;
  }
  // Closes respect DEALER mode: the same gate the open path applies (resolveWantsDealingQueue)
  // -- when the account is dealer-managed the close is QUEUED (a MARKET order that closes this
  // position, full or partial), the position is locked, and the dealer decides; nothing is
  // executed here. Automatic closes (SL / TP / stop-out) never come through this route.
  // The queued order carries the client's reference as its requestedPrice -- the dealer prices
  // the close at accept time (app/api/manage/dealing-queue/[id]), so no slippage check here.
  const routing = await accountWantsDealingQueue(prisma, session.brokerId, position.account.group);
  if (routing.wantsQueue) {
    const clientPlatformHeader = request.headers.get("x-client-platform");
    const orderSource: "WEB" | "DESKTOP_NATIVE" | "MOBILE" | "API" =
      clientPlatformHeader === "DESKTOP_NATIVE" || clientPlatformHeader === "MOBILE" || clientPlatformHeader === "API" ? clientPlatformHeader : "WEB";
    const idempotencyKey = typeof body?.idempotencyKey === "string" && body.idempotencyKey.length > 0 ? body.idempotencyKey : `close:${position.id}:${Date.now()}`;
    let queued;
    try {
      queued = await prisma.$transaction((tx) =>
        queueCloseInTx(tx, {
          brokerId: session.brokerId,
          accountId: session.accountId,
          position: { id: position.id, symbolId: position.symbol.id, side: position.side, volume: position.volume, ticket: position.ticket, closePendingOrderId: position.closePendingOrderId },
          closeVolume,
          requestedPrice: clientReferencePrice,
          idempotencyKey,
          source: orderSource,
          symbolName: position.symbol.name,
          accountNumber: position.account.accountNumber,
          note: source === "stm_bulk" ? "STM bulk close" : "Client close",
        })
      );
    } catch (err) {
      if (err instanceof ClosePendingError) return NextResponse.json({ error: "CLOSE_PENDING", orderId: err.orderId }, { status: 409 });
      if (err instanceof Error && err.message === "RACED") return NextResponse.json({ error: "position was already closed" }, { status: 409 });
      throw err;
    }
    await afterCloseQueued(prisma, {
      order: queued,
      brokerId: session.brokerId,
      accountId: session.accountId,
      accountNumber: position.account.accountNumber,
      accountFullName: position.account.fullName,
      symbolName: position.symbol.name,
      digits: position.symbol.digits,
      side: position.side,
      closeVolume,
      positionId: position.id,
      positionTicket: position.ticket,
      positionVolume: position.volume,
      liveBid: livePrice.bid,
      liveAsk: livePrice.ask,
    });
    // 202: accepted for dealer review, nothing closed yet -- the client keeps the position, locked
    return NextResponse.json({ queued: true, order: queued, positionId: position.id, closeVolume: closeVolume.toString() }, { status: 202 });
  }

  // Slippage: the server's fill vs what the client saw, within the client's
  // tolerance, else the broker default, else lib/risk.ts's hardcoded default
  // -- the identical chain the open path runs on its MARKET fill.
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId }, select: { defaultMaxSlippagePips: true } });
  const slippageError = checkSlippage({
    clientReferencePrice,
    serverFillPrice: closePrice,
    maxSlippagePips: maxSlippagePips ?? (broker.defaultMaxSlippagePips != null ? broker.defaultMaxSlippagePips.toString() : null),
    digits: position.symbol.digits,
  });
  if (slippageError) {
    return NextResponse.json({ error: slippageError, serverPrice: closePrice.toString() }, { status: 400 });
  }

  const outcome = await prisma.$transaction((tx) =>
    closePositionInTx(tx, {
      position: {
        id: position.id,
        accountId: session.accountId,
        brokerId: session.brokerId,
        side: position.side,
        openPrice: position.openPrice,
        volume: position.volume,
        symbol: { contractSize: position.symbol.contractSize },
      },
      closePrice,
      closeVolume,
    })
  );

  if (!outcome.closed) {
    // Lost a race with a concurrent close (another tab, or the risk
    // monitor's own SL/TP/stop-out closing the same position at the same
    // instant) between the read above and the transaction's own guarded
    // UPDATE. The position is genuinely closed/reduced already, just not
    // by this call -- report the current state, not a false success.
    return NextResponse.json({ error: "position was already closed" }, { status: 409 });
  }

  if (source === "stm_bulk") {
    await prisma.auditLog.create({
      data: {
        brokerId: session.brokerId,
        action: "STM_BULK_CLOSE",
        entityType: "Position",
        entityId: position.id,
        oldValue: { volume: position.volume.toString() },
        newValue: { closeVolume: closeVolume.toString(), partial: outcome.partial },
      },
    });
  }
  // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- after this route's own
  // transaction has committed, never inside it (same reasoning as the
  // fill-path hook in app/api/trade/orders/route.ts). `position.volume`
  // here is still this route's own top-of-function read, from before
  // closePositionInTx reduced/closed the row -- exactly the "source
  // volume before this close" onClose needs to compute a proportional
  // close on the mirrored side.
  await mirror.onClose(prisma, {
    positionId: position.id,
    brokerId: session.brokerId,
    closedLots: closeVolume,
    sourceVolumeBeforeClose: position.volume,
    closePrice,
  }).catch((err) => console.error("mirror.onClose failed", err));
  // coverage follow-through (lib/coverage.ts onClose): a booked position's hedge leg closes with it
  await coverage.onClose(prisma, { positionId: position.id, brokerId: session.brokerId, closedLots: closeVolume, sourceVolumeBeforeClose: position.volume, reason: "manual" }).catch((err) => console.error("coverage.onClose failed", err));
  await publishTradingEvent("PositionClosed", { position_id: position.id, account_id: session.accountId, broker_id: session.brokerId });
  await recordDealerActivity(prisma, {
    brokerId: session.brokerId,
    accountId: session.accountId,
    accountNumber: position.account.accountNumber,
    accountFullName: position.account.fullName,
    isDealingGroup: isDealingManagedAccount({
      group: position.account.group,
      brokerDealingModeOn: routing.brokerDealingModeOn,
      dealingDeskAutoFillOn: routing.dealingDeskAutoFillOn,
    }),
    action: "POSITION_CLOSED",
    symbol: position.symbol.name,
    side: position.side,
    volume: closeVolume.toString(),
    values: { closePrice: closePrice.toString(), clientReferencePrice, partial: outcome.partial, realizedPnl: outcome.realizedPnl.toString(), closeReason: "MANUAL", origin: source === "stm_bulk" ? "client_stm" : "client_close" },
    positionId: position.id,
  });
  return NextResponse.json({ position: outcome.position, transaction: outcome.transaction, partial: outcome.partial });
}
