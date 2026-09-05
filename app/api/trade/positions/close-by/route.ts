import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { closePositionsByEachOther } from "@/lib/close-by";

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
