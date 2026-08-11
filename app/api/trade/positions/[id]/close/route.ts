import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { computeRealizedPnl } from "@/lib/trading";

// Closing a position is the one place a trade changes the account balance.
// Realized P&L is computed server-side and applied atomically alongside a
// ledger Transaction row — never a silent balance overwrite.
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

  const realizedPnl = computeRealizedPnl({
    side: position.side,
    openPrice: position.openPrice,
    closePrice,
    volume: position.volume,
    contractSize: position.symbol.contractSize,
  });

  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { id: session.accountId } });
    const balanceBefore = account.balance;
    const balanceAfter = balanceBefore.add(realizedPnl);

    const closedPosition = await tx.position.update({
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
      },
    });

    return { position: closedPosition, transaction };
  });

  return NextResponse.json(result);
}
