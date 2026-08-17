import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Manual (admin-initiated) position close -- mirrors
// app/api/trade/positions/[id]/close/route.ts's balance/Transaction
// shape exactly (read balance inside the transaction, compute
// balanceAfter, explicit `data: { balance: balanceAfter }` rather than
// `increment`, same TRADE_PNL Transaction row), scoped by brokerId
// instead of the trader route's accountId-ownership check since an
// admin acts on any account under their own broker. First real usage of
// Position.closedByAdminId and the "MANUAL_POSITION_CLOSE" AuditLog
// action -- both existed in the schema/doc comments already but nothing
// wrote them until now. Price comes from LivePrice (confirmed with the
// user), not an admin-typed value.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const body = await request.json().catch(() => null);
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

  const price = await getFreshPrice(position.symbol.name);
  if (!price) {
    return NextResponse.json({ error: `no live price for ${position.symbol.name}` }, { status: 409 });
  }
  // Same close-price convention as calc::close_price_for (Rust engine)
  // and this session's positions dashboard: bid for an open BUY, ask
  // for an open SELL -- what closing it right now would actually fill at.
  const closePrice = position.side === "BUY" ? price.bid : price.ask;

  const realizedPnl = computeRealizedPnl({
    side: position.side,
    openPrice: position.openPrice,
    closePrice,
    volume: closeVolume,
    contractSize: position.symbol.contractSize,
  });

  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { id: position.accountId } });
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
            closedByAdminId: session.adminId,
          },
        });

    await tx.account.update({
      where: { id: position.accountId },
      data: { balance: balanceAfter },
    });

    const transaction = await tx.transaction.create({
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
        note: isPartial
          ? `Manual partial close by admin: ${closeVolume} lots @ ${closePrice}`
          : `Manual close by admin @ ${closePrice}`,
      },
    });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "MANUAL_POSITION_CLOSE",
        entityType: "Position",
        entityId: position.id,
        oldValue: {
          status: "OPEN",
          volume: position.volume.toString(),
        },
        newValue: {
          accountNumber: position.account.accountNumber,
          symbol: position.symbol.name,
          closeVolume: closeVolume.toString(),
          closePrice: closePrice.toString(),
          realizedPnl: realizedPnl.toString(),
          partial: isPartial,
        },
      },
    });

    return { position: updatedPosition, transaction, partial: isPartial };
  });

  return NextResponse.json({
    positionId: result.position.id,
    partial: result.partial,
    closePrice: closePrice.toString(),
    realizedPnl: realizedPnl.toString(),
  });
}
