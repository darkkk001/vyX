import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// Called by the client when its local price simulation reports the
// resting LIMIT/STOP order's trigger price has been hit. Moves the order
// through PENDING -> ACCEPTED -> FILLED and opens the resulting Position,
// atomically. (Phase 5's real engine replaces this trigger-detection with
// server-side matching against a live feed; the state machine itself
// doesn't change.)
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
  const fillPrice = body?.price != null ? String(body.price) : null;
  if (!fillPrice) {
    return NextResponse.json({ error: "price is required" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order || order.accountId !== session.accountId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: `cannot fill an order in status ${order.status}` }, { status: 409 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId: order.brokerId, symbolId: order.symbolId },
  });

  const result = await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: "ACCEPTED" } });
    const filledOrder = await tx.order.update({
      where: { id: order.id },
      data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date() },
    });
    const position = await tx.position.create({
      data: {
        brokerId: order.brokerId,
        accountId: order.accountId,
        symbolId: order.symbolId,
        originOrderId: order.id,
        side: order.side,
        volume: order.volume,
        openPrice: fillPrice,
        slPrice: order.slPrice,
        tpPrice: order.tpPrice,
        bookType: brokerSymbol?.defaultBookType ?? "B_BOOK",
      },
    });
    return { order: filledOrder, position };
  });

  return NextResponse.json(result);
}
