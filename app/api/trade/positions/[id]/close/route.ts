import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { closePositionInTx } from "@/lib/position-close";
import { publishTradingEvent } from "@/lib/nats";

// Closing (fully or partially) is the one place a trade changes the
// account balance. Realized P&L is computed server-side and applied
// atomically alongside a ledger Transaction row — never a silent balance
// overwrite. A partial close (volume < position.volume) reduces the
// position's volume and keeps it OPEN rather than closing it outright;
// the Transaction row is still the authoritative record of what was
// realized and when.
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
  const closePrice = body?.closePrice != null ? String(body.closePrice) : null;
  if (!closePrice) {
    return NextResponse.json({ error: "closePrice is required" }, { status: 400 });
  }
  // Informational only, doesn't change validation/execution -- flags this
  // close for the STM_BULK_CLOSE audit trail. See
  // components/webtrader/SmartTradeManager.tsx's runBulk/partialCloseOne/
  // closeOne and docs/webtrader-stm-architecture-review.md §4.6.
  const source = body?.source === "stm_bulk" ? "stm_bulk" : null;

  const position = await prisma.position.findUnique({
    where: { id },
    include: { symbol: { select: { contractSize: true } } },
  });
  if (!position || position.accountId !== session.accountId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }

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
    closeVolume = requested;
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
  await publishTradingEvent("PositionClosed", { position_id: position.id, account_id: session.accountId });
  return NextResponse.json({ position: outcome.position, transaction: outcome.transaction, partial: outcome.partial });
}
