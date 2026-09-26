import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { closePositionsByEachOther, resolveCloseByPair } from "@/lib/close-by";
import { accountWantsDealingQueue, afterCloseQueued, queueCloseInTx, ClosePendingError } from "@/lib/queued-close";

// "Close By" -- nets the smaller of two opposite-side
// positions on the same symbol against the larger one at a single fair
// (midpoint) price, closing both legs in one transaction with one
// PositionsClosed event. See lib/close-by.ts for the full reasoning.
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const positionId = typeof body?.positionId === "string" ? body.positionId : "";
  const againstPositionId = typeof body?.againstPositionId === "string" ? body.againstPositionId : "";
  if (!positionId || !againstPositionId) {
    return NextResponse.json({ error: "positionId and againstPositionId are required" }, { status: 400 });
  }

  // Closes respect DEALER mode (docs/CLOSES-RESPECT-DEALER-MODE.md, policy (a)): on a dealer-
  // managed account BOTH legs are queued as close Orders (the netted volume each, at the mid the
  // client saw), each locking its position; the dealer accepts / rejects them one by one.
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true, category: true } } },
  });
  const routing = await accountWantsDealingQueue(prisma, session.brokerId, account.group);
  if (routing.wantsQueue) {
    const pair = await resolveCloseByPair(prisma, { accountId: session.accountId, brokerId: session.brokerId, positionId, againstPositionId });
    if (!pair.ok) {
      return NextResponse.json({ error: pair.error, ...(pair.nextOpenAt ? { nextOpenAt: pair.nextOpenAt } : {}) }, { status: 400 });
    }
    const { a, b, live, closePrice, closeVolume } = pair;
    if (a.closePendingOrderId || b.closePendingOrderId) {
      return NextResponse.json({ error: "CLOSE_PENDING", orderId: a.closePendingOrderId ?? b.closePendingOrderId }, { status: 409 });
    }
    const clientPlatformHeader = request.headers.get("x-client-platform");
    const orderSource: "WEB" | "DESKTOP_NATIVE" | "MOBILE" | "API" =
      clientPlatformHeader === "DESKTOP_NATIVE" || clientPlatformHeader === "MOBILE" || clientPlatformHeader === "API" ? clientPlatformHeader : "WEB";
    const batch = Date.now();
    let orders;
    try {
      orders = await prisma.$transaction(async (tx) => {
        const oa = await queueCloseInTx(tx, {
          brokerId: session.brokerId, accountId: session.accountId,
          position: { id: a.id, symbolId: a.symbol.id, side: a.side, volume: a.volume, ticket: a.ticket, closePendingOrderId: a.closePendingOrderId },
          closeVolume, requestedPrice: closePrice, idempotencyKey: `close:${a.id}:${batch}`, source: orderSource,
          symbolName: a.symbol.name, accountNumber: account.accountNumber, note: `Close by #${b.ticket}`,
        });
        const ob = await queueCloseInTx(tx, {
          brokerId: session.brokerId, accountId: session.accountId,
          position: { id: b.id, symbolId: b.symbol.id, side: b.side, volume: b.volume, ticket: b.ticket, closePendingOrderId: b.closePendingOrderId },
          closeVolume, requestedPrice: closePrice, idempotencyKey: `close:${b.id}:${batch}`, source: orderSource,
          symbolName: b.symbol.name, accountNumber: account.accountNumber, note: `Close by #${a.ticket}`,
        });
        return { oa, ob };
      });
    } catch (err) {
      if (err instanceof ClosePendingError) return NextResponse.json({ error: "CLOSE_PENDING", orderId: err.orderId }, { status: 409 });
      if (err instanceof Error && err.message === "RACED") return NextResponse.json({ error: "one of the positions was already closed or modified" }, { status: 409 });
      throw err;
    }
    for (const [order, pos] of [[orders.oa, a], [orders.ob, b]] as const) {
      await afterCloseQueued(prisma, {
        order, brokerId: session.brokerId, accountId: session.accountId,
        accountNumber: account.accountNumber, accountFullName: account.fullName,
        symbolName: pos.symbol.name, digits: pos.symbol.digits, side: pos.side,
        closeVolume, positionId: pos.id, positionTicket: pos.ticket, positionVolume: pos.volume,
        liveBid: live.bid, liveAsk: live.ask,
      });
    }
    return NextResponse.json({ ok: true, queued: true, closeVolume: closeVolume.toString(), closePrice: closePrice.toString(), positionAId: a.id, positionBId: b.id, orderAId: orders.oa.id, orderBId: orders.ob.id }, { status: 202 });
  }

  const result = await closePositionsByEachOther(prisma, {
    accountId: session.accountId,
    brokerId: session.brokerId,
    positionId,
    againstPositionId,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.nextOpenAt ? { nextOpenAt: result.nextOpenAt } : {}) },
      { status: 400 }
    );
  }
  return NextResponse.json(result);
}
