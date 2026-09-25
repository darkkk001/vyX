import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { ensureCoverageAccount } from "@/lib/coverage";
import { publishTradingEvent } from "@/lib/nats";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Dealer BOOK NOW -- hedge one B-book client position onto the broker's
// coverage account (see lib/coverage.ts). The client position is left
// completely untouched (still OPEN, still theirs); this only mirrors the
// SAME-side leg onto the coverage account so the broker's own book nets
// flat, and flips Position.covered so the position leaves the Smart Dealer
// Manager's unbooked list.
//
// Why the SAME side, not opposite: a B-book broker is the counterparty to
// the client, so it holds the opposite exposure internally. Client BUY 1
// lot => broker effectively short 1 lot. To neutralise that the coverage
// account must go long (BUY) 1 lot -- the same side as the client. P&L
// walk-through: price rises, client +$100, broker owes -$100 on its book,
// coverage BUY gains +$100 => broker net 0. A coverage SELL would double
// the risk instead of hedging it.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // owner decision 2026-09-25 (audit Batch 4): DEALING -- BROKER_ADMIN, or a MANAGER granted it. No second admin
  // (dealing needs speed); every action writes its audit row.
  if (await forbidUnlessBrokerAdminOrPermission(session, "DEALING")) {
    return NextResponse.json({ error: "forbidden", permission: "DEALING", permissionLabel: PERMISSION_LABELS.DEALING }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const position = await prisma.position.findUnique({
    where: { id },
    include: { symbol: { select: { name: true, digits: true } } },
  });
  if (!position || position.brokerId !== brokerId || position.deletedAt) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "only an open position can be booked" }, { status: 400 });
  }
  if (position.covered) {
    return NextResponse.json({ error: "position is already booked" }, { status: 400 });
  }
  // Only B-book positions are the broker's own risk to hedge. An A_BOOK
  // position is already market-facing (LP or coverage) -- nothing to book.
  if (position.bookType !== "B_BOOK") {
    return NextResponse.json({ error: "only a B-book position can be booked" }, { status: 400 });
  }

  const coverage = await ensureCoverageAccount(brokerId, session.adminId);
  if (position.accountId === coverage.accountId) {
    return NextResponse.json({ error: "cannot book a coverage-account position" }, { status: 400 });
  }

  // Raw live market price -- the hedge fills at the real market, no spread
  // markup and no commission (the whole point of a coverage account).
  const live = await getFreshPrice(position.symbol.name);
  if (!live) {
    return NextResponse.json({ error: `no live price for ${position.symbol.name}` }, { status: 409 });
  }
  const fillPrice = position.side === "BUY" ? live.ask : live.bid;

  const result = await prisma.$transaction(async (tx) => {
    // Re-check covered inside the transaction so two simultaneous BOOK NOW
    // clicks can't both create a hedge leg for the same position.
    const fresh = await tx.position.findUnique({ where: { id }, select: { covered: true } });
    if (!fresh || fresh.covered) return null;

    const order = await tx.order.create({
      data: {
        brokerId,
        accountId: coverage.accountId,
        symbolId: position.symbolId,
        side: position.side,
        type: "MARKET",
        volume: position.volume,
        requestedPrice: fillPrice,
        idempotencyKey: `coverage_${randomUUID()}`,
        status: "FILLED",
        source: "ADMIN",
        filledPrice: fillPrice,
        filledAt: new Date(),
      },
    });
    const coveragePosition = await tx.position.create({
      data: {
        brokerId,
        accountId: coverage.accountId,
        symbolId: position.symbolId,
        originOrderId: order.id,
        side: position.side,
        volume: position.volume,
        openPrice: fillPrice,
        // A_BOOK: the coverage leg is the broker's real market exposure.
        bookType: "A_BOOK",
      },
    });
    const updated = await tx.position.update({
      where: { id },
      data: { covered: true, coveredAt: new Date(), coveragePositionId: coveragePosition.id },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "POSITION_COVERAGE_BOOKED",
        entityType: "Position",
        entityId: position.id,
        newValue: {
          clientPositionId: position.id,
          clientTicket: position.ticket,
          coveragePositionId: coveragePosition.id,
          coverageTicket: coveragePosition.ticket,
          coverageAccountId: coverage.accountId,
          symbol: position.symbol.name,
          side: position.side,
          volume: position.volume.toString(),
          bookPrice: fillPrice.toString(),
        },
      },
    });
    return { order, coveragePosition, updated };
  });

  if (!result) {
    return NextResponse.json({ error: "position is already booked" }, { status: 400 });
  }

  // Publish the coverage fill so the exposure/positions views pick up the
  // new hedge leg without a manual refresh (same as the manual-open path).
  await publishTradingEvent("OrderFilled", {
    order_id: result.order.id,
    account_id: coverage.accountId,
    broker_id: brokerId,
    price: fillPrice.toString(),
    volume: position.volume.toString(),
    remaining_volume: "0",
  }).catch((err) => console.error("publish coverage OrderFilled failed", err));

  return NextResponse.json({
    positionId: position.id,
    covered: true,
    coveragePositionId: result.coveragePosition.id,
    coverageTicket: result.coveragePosition.ticket,
    coverageAccountId: coverage.accountId,
    symbol: position.symbol.name,
    side: position.side,
    volume: position.volume.toString(),
    bookPrice: fillPrice.toString(),
  });
}
