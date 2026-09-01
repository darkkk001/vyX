import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";
import { randomUUID } from "node:crypto";
import * as mirror from "@/lib/mirror";
import { publishTradingEvent } from "@/lib/nats";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Closes the position at the current live price (same price-authority
// rule as [id]/close/route.ts -- never an admin-typed price) and opens a
// new position on the opposite side at that same price, in one
// transaction. Mirrors close/route.ts's booking shape for the close leg
// and positions/route.ts's manual-open shape for the new leg.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const position = await prisma.position.findUnique({
    where: { id },
    include: { symbol: { select: { name: true, contractSize: true } }, account: { select: { accountNumber: true } } },
  });
  if (!position || position.brokerId !== brokerId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }

  const price = await getFreshPrice(position.symbol.name);
  if (!price) {
    return NextResponse.json({ error: `no live price for ${position.symbol.name}` }, { status: 409 });
  }
  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId, symbolId: position.symbolId },
  });
  const closePrice = position.side === "BUY" ? price.bid : price.ask;
  const newSide = position.side === "BUY" ? "SELL" : "BUY";
  // The new leg opens immediately at the reverse's own fill convention
  // (BUY fills at ask, SELL at bid), same as a fresh manual open.
  const openPrice = newSide === "BUY" ? price.ask : price.bid;

  const realizedPnl = computeRealizedPnl({
    side: position.side,
    openPrice: position.openPrice,
    closePrice,
    volume: position.volume,
    contractSize: position.symbol.contractSize,
  });

  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { id: position.accountId } });
    const balanceBefore = account.balance;
    const balanceAfter = balanceBefore.add(realizedPnl);

    const closedPosition = await tx.position.update({
      where: { id: position.id },
      data: { status: "CLOSED", closePrice, realizedPnl, closedAt: new Date(), closedByAdminId: session.adminId },
    });

    await tx.account.update({ where: { id: position.accountId }, data: { balance: balanceAfter } });

    await tx.transaction.create({
      data: {
        brokerId,
        accountId: position.accountId,
        type: "TRADE_PNL",
        status: "COMPLETED",
        amount: realizedPnl,
        balanceBefore,
        balanceAfter,
        referenceType: "Position",
        referenceId: position.id,
        note: `Reversed by admin @ ${closePrice}`,
      },
    });

    const newOrder = await tx.order.create({
      data: {
        brokerId,
        accountId: position.accountId,
        symbolId: position.symbolId,
        side: newSide,
        type: "MARKET",
        volume: position.volume,
        requestedPrice: openPrice,
        idempotencyKey: `manual_${randomUUID()}`,
        status: "FILLED",
        filledPrice: openPrice,
        filledAt: new Date(),
      },
    });
    const newPosition = await tx.position.create({
      data: {
        brokerId,
        accountId: position.accountId,
        symbolId: position.symbolId,
        originOrderId: newOrder.id,
        side: newSide,
        volume: position.volume,
        openPrice,
        bookType: brokerSymbol?.defaultBookType ?? "B_BOOK",
      },
    });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "MANUAL_POSITION_REVERSE",
        entityType: "Position",
        entityId: position.id,
        oldValue: { side: position.side, status: "OPEN" },
        newValue: {
          accountNumber: position.account.accountNumber,
          symbol: position.symbol.name,
          closedSide: position.side,
          closePrice: closePrice.toString(),
          realizedPnl: realizedPnl.toString(),
          newPositionId: newPosition.id,
          newSide,
          openPrice: openPrice.toString(),
        },
      },
    });

    return { closedPosition, newPosition };
  });

  // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- mirror hook gap fix: a reverse
  // is two real trade events in one admin action -- the original position
  // closing, and a brand-new one opening on the other side -- both need
  // their own hook, in that order (close first, matching the order these
  // two events actually happened in).
  await mirror.onClose(prisma, {
    positionId: position.id,
    brokerId,
    closedLots: position.volume,
    sourceVolumeBeforeClose: position.volume,
  }).catch((err) => console.error("mirror.onClose failed", err));
  await mirror.onFillPosition(prisma, result.newPosition, position.symbol.name).catch((err) => console.error("mirror.onFill failed", err));
  // Realtime-sync gap fix -- this route never published a live event at
  // all before, on top of lib/nats.ts's own (separately fixed) transport
  // bug. Same order as the mirror hooks above: the close first, then the
  // new leg's fill.
  await publishTradingEvent("PositionClosed", { position_id: position.id, account_id: position.accountId, broker_id: brokerId });
  await publishTradingEvent("OrderFilled", {
    order_id: result.newPosition.originOrderId,
    account_id: position.accountId,
    broker_id: brokerId,
    price: openPrice.toString(),
    volume: position.volume.toString(),
    remaining_volume: "0",
  });

  return NextResponse.json({
    closedPositionId: result.closedPosition.id,
    realizedPnl: realizedPnl.toString(),
    newPositionId: result.newPosition.id,
    newSide,
    openPrice: openPrice.toString(),
  });
}
