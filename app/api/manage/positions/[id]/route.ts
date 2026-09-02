import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrice } from "@/lib/live-price";
import { validateSlTp } from "@/lib/trading";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Modify an OPEN position's SL/TP -- Position.slPrice/tpPrice already
// existed in the schema but nothing wrote them until now (see
// docs/trading-engine.md's implementation-status note, which flagged this
// gap). Targets the position directly (unlike app/api/trade/orders, which
// only modifies a still-PENDING order) -- matches what the live Next.js
// trading path already does for a trader's own modify action.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const position = await prisma.position.findUnique({
    where: { id },
    include: { symbol: { select: { name: true } }, account: { select: { accountNumber: true } } },
  });
  if (!position || position.brokerId !== brokerId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }

  let slPrice: Prisma.Decimal | null = position.slPrice;
  let tpPrice: Prisma.Decimal | null = position.tpPrice;
  if (body?.slPrice !== undefined) {
    try {
      slPrice = body.slPrice === null || body.slPrice === "" ? null : new Prisma.Decimal(String(body.slPrice));
    } catch {
      return NextResponse.json({ error: "invalid slPrice" }, { status: 400 });
    }
  }
  if (body?.tpPrice !== undefined) {
    try {
      tpPrice = body.tpPrice === null || body.tpPrice === "" ? null : new Prisma.Decimal(String(body.tpPrice));
    } catch {
      return NextResponse.json({ error: "invalid tpPrice" }, { status: 400 });
    }
  }

  // Validated against the current market price -- what closing (or
  // triggering) the position right now would actually reference -- same
  // bid/BUY, ask/SELL convention as the close route's own closePrice.
  const price = await getFreshPrice(position.symbol.name);
  if (!price) {
    return NextResponse.json({ error: `no live price for ${position.symbol.name}` }, { status: 409 });
  }
  const referencePrice = position.side === "BUY" ? price.bid : price.ask;
  const brokerSymbol = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId: position.brokerId, symbolId: position.symbolId } },
    include: { symbol: { select: { digits: true } } },
  });
  const validationError = validateSlTp({
    side: position.side,
    referencePrice,
    slPrice,
    tpPrice,
    digits: brokerSymbol?.symbol.digits,
    stopLevel: brokerSymbol?.stopLevel,
  });
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.position.update({
      where: { id: position.id },
      data: { slPrice, tpPrice },
    });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "POSITION_SLTP_MODIFIED",
        entityType: "Position",
        entityId: position.id,
        oldValue: {
          slPrice: position.slPrice?.toString() ?? null,
          tpPrice: position.tpPrice?.toString() ?? null,
        },
        newValue: {
          accountNumber: position.account.accountNumber,
          symbol: position.symbol.name,
          slPrice: slPrice?.toString() ?? null,
          tpPrice: tpPrice?.toString() ?? null,
          reason,
        },
      },
    });

    return result;
  });

  return NextResponse.json({
    positionId: updated.id,
    slPrice: updated.slPrice?.toString() ?? null,
    tpPrice: updated.tpPrice?.toString() ?? null,
  });
}
