import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { closeBulkForAccount, selectBulkCloseTargets, type BulkCloseScope, type BulkClosePositionResult } from "@/lib/bulk-close";
import { closePriceFor } from "@/lib/trading";
import { accountWantsDealingQueue, afterCloseQueued, queueCloseInTx, ClosePendingError } from "@/lib/queued-close";

const SCOPES: BulkCloseScope[] = ["ALL", "PROFIT", "LOSS", "SYMBOL"];

// Replaces the trader terminal's old "Close all / Close profitable /
// Close losing / Close all in <symbol>" buttons, each of which used to
// fire one /positions/[id]/close call per position sequentially
// (components/webtrader/WebTrader.tsx's closeManyBy/closeManyBySymbol) --
// 30 positions took 15-20s, each closing at a slightly different price as
// the feed ticked between calls. This is one request, one transaction,
// one price snapshot per symbol -- see lib/bulk-close.ts for the shared
// logic this shares with the backoffice's own "close all for account".
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const scope = SCOPES.includes(body?.scope) ? (body.scope as BulkCloseScope) : null;
  if (!scope) {
    return NextResponse.json({ error: "scope must be one of ALL, PROFIT, LOSS, SYMBOL" }, { status: 400 });
  }
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : undefined;
  if (scope === "SYMBOL" && !symbol) {
    return NextResponse.json({ error: "symbol is required for scope SYMBOL" }, { status: 400 });
  }

  // Closes respect DEALER mode (docs/CLOSES-RESPECT-DEALER-MODE.md): on a dealer-managed account
  // the same scope selects the positions, but each becomes a queued close Order (locking its
  // position) instead of closing -- N queue rows for the dealer, nothing executed here. The admin
  // bulk close (app/api/manage/positions/close-bulk) keeps executing directly.
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true, category: true } } },
  });
  const routing = await accountWantsDealingQueue(prisma, session.brokerId, account.group);
  if (routing.wantsQueue) {
    const clientPlatformHeader = request.headers.get("x-client-platform");
    const orderSource: "WEB" | "DESKTOP_NATIVE" | "MOBILE" | "API" =
      clientPlatformHeader === "DESKTOP_NATIVE" || clientPlatformHeader === "MOBILE" || clientPlatformHeader === "API" ? clientPlatformHeader : "WEB";
    const { matching, priceBySymbol, nextOpenBySymbolName } = await selectBulkCloseTargets(prisma, { accountId: session.accountId, brokerId: session.brokerId, scope, symbol });
    const results: BulkClosePositionResult[] = [];
    const batch = Date.now();
    for (const p of matching) {
      const nextOpenAt = nextOpenBySymbolName.get(p.symbol.name);
      if (nextOpenAt) { results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: "MARKET_CLOSED", nextOpenAt }); continue; }
      const live = priceBySymbol.get(p.symbol.name);
      if (!live) { results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: "no live price" }); continue; }
      if (p.closePendingOrderId) { results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: "CLOSE_PENDING", queued: true, orderId: p.closePendingOrderId }); continue; }
      const requestedPrice = closePriceFor(p.side, live.bid, live.ask);
      try {
        const order = await prisma.$transaction((tx) =>
          queueCloseInTx(tx, {
            brokerId: session.brokerId,
            accountId: session.accountId,
            position: { id: p.id, symbolId: p.symbol.id, side: p.side, volume: p.volume, ticket: p.ticket, closePendingOrderId: p.closePendingOrderId },
            closeVolume: p.volume,
            requestedPrice,
            idempotencyKey: `close:${p.id}:${batch}`,
            source: orderSource,
            symbolName: p.symbol.name,
            accountNumber: account.accountNumber,
            note: `Bulk close (${scope})`,
          })
        );
        await afterCloseQueued(prisma, {
          order,
          brokerId: session.brokerId,
          accountId: session.accountId,
          accountNumber: account.accountNumber,
          accountFullName: account.fullName,
          symbolName: p.symbol.name,
          digits: p.symbol.digits,
          side: p.side,
          closeVolume: p.volume,
          positionId: p.id,
          positionTicket: p.ticket,
          positionVolume: p.volume,
          liveBid: live.bid,
          liveAsk: live.ask,
        });
        results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: null, queued: true, orderId: order.id });
      } catch (err) {
        if (err instanceof ClosePendingError) results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: "CLOSE_PENDING", queued: true, orderId: err.orderId });
        else if (err instanceof Error && err.message === "RACED") results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: "already closed" });
        else throw err;
      }
    }
    return NextResponse.json({
      requested: results.length,
      successful: 0,
      failed: results.filter((r) => !r.queued).length,
      queued: results.filter((r) => r.queued && r.error === null).length,
      results,
    }, { status: 202 });
  }

  const results = await closeBulkForAccount(prisma, {
    accountId: session.accountId,
    brokerId: session.brokerId,
    scope,
    symbol,
  });

  return NextResponse.json({
    requested: results.length,
    successful: results.filter((r) => r.closed).length,
    failed: results.filter((r) => !r.closed).length,
    results,
  });
}
