import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { validateSlTp } from "@/lib/trading";
import { publishTradingEvent } from "@/lib/nats";

// Inline SL/TP edit on an open position — side-aware validated against the
// client-reported current price, same rule as order placement.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const currentPrice = body?.currentPrice != null ? String(body.currentPrice) : null;
  const slPrice = body?.slPrice !== undefined ? (body.slPrice == null ? null : String(body.slPrice)) : undefined;
  const tpPrice = body?.tpPrice !== undefined ? (body.tpPrice == null ? null : String(body.tpPrice)) : undefined;

  if (!currentPrice) {
    return NextResponse.json({ error: "currentPrice is required" }, { status: 400 });
  }

  const position = await prisma.position.findUnique({ where: { id } });
  if (!position || position.accountId !== session.accountId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }

  const validationError = validateSlTp({
    side: position.side,
    referencePrice: currentPrice,
    slPrice: slPrice === undefined ? position.slPrice : slPrice,
    tpPrice: tpPrice === undefined ? position.tpPrice : tpPrice,
  });
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const updated = await prisma.position.update({
    where: { id },
    data: {
      ...(slPrice !== undefined ? { slPrice } : {}),
      ...(tpPrice !== undefined ? { tpPrice } : {}),
    },
  });
  await publishTradingEvent("PositionModified", { position_id: id, account_id: session.accountId, broker_id: session.brokerId });
  return NextResponse.json(updated);
}
