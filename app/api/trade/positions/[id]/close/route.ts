import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { computeRealizedPnl } from "@/lib/trading";

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
  const isPartial = closeVolume.lt(position.volume);

  const realizedPnl = computeRealizedPnl({
    side: position.side,
    openPrice: position.openPrice,
    closePrice,
    volume: closeVolume,
    contractSize: position.symbol.contractSize,
  });

  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { id: session.accountId } });
    const balanceBefore = account.balance;
    const balanceAfter = balanceBefore.add(realizedPnl);

    const updatedPosition = isPartial
      ? await tx.position.update({
          where: { id: position.id },
          data: { volume: position.volume.sub(closeVolume) },
        })
      : await tx.position.update({
          where: { id: position.id },
          data: {
            status: "CLOSED",
            closePrice,
            realizedPnl,
            closedAt: new Date(),
          },
        });

    await tx.account.update({
      where: { id: session.accountId },
      data: { balance: balanceAfter },
    });

    const transaction = await tx.transaction.create({
      data: {
        brokerId: session.brokerId,
        accountId: session.accountId,
        type: "TRADE_PNL",
        status: "COMPLETED",
        amount: realizedPnl,
        balanceBefore,
        balanceAfter,
        referenceType: "Position",
        referenceId: position.id,
        note: isPartial ? `Partial close: ${closeVolume} lots @ ${closePrice}` : null,
      },
    });

    return { position: updatedPosition, transaction, partial: isPartial };
  });

  return NextResponse.json(result);
}
