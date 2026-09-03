import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import * as mirror from "@/lib/mirror";
import { publishTradingEvent } from "@/lib/nats";
import {
  PositionActionError,
  executeReverseInPlace,
  executeReverseCloseReopen,
  requestPositionAction,
  positionActionNeedsApproval,
  type ReverseInPlaceResult,
  type ReverseCloseReopenResult,
} from "@/lib/position-actions";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Reverse, redesigned (VYX-POSITION-TOOLS-V0): defaults to an in-place
// direction flip (no close, no new position, no realized P&L -- see
// lib/position-actions.ts's executeReverseInPlace); `mode:
// "CLOSE_REOPEN"` in the body keeps the old close-and-reopen-opposite
// behavior available as the explicit second option the brief asks for.
// MANAGER's call only ever creates a PENDING PositionActionRequest here
// -- see app/api/manage/position-action-requests/[id]/approve/route.ts
// for where it actually executes.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode === "CLOSE_REOPEN" ? "CLOSE_REOPEN" : "IN_PLACE";
  const actionType = mode === "CLOSE_REOPEN" ? "REVERSE_CLOSE_REOPEN" : "REVERSE_IN_PLACE";

  if (positionActionNeedsApproval(session.role as "MANAGER" | "BROKER_ADMIN")) {
    try {
      const created = await prisma.$transaction((tx) =>
        requestPositionAction(tx, { brokerId, positionId: id, adminId: session.adminId, actionType, reason: null })
      );
      return NextResponse.json({ pending: true, requestId: created.id }, { status: 202 });
    } catch (err) {
      const message = err instanceof PositionActionError ? err.message : "reverse request failed";
      return NextResponse.json({ error: message }, { status: 409 });
    }
  }

  let result: ReverseInPlaceResult | ReverseCloseReopenResult;
  try {
    result =
      mode === "CLOSE_REOPEN"
        ? await prisma.$transaction((tx) => executeReverseCloseReopen(tx, { brokerId, positionId: id, adminId: session.adminId }))
        : await prisma.$transaction((tx) => executeReverseInPlace(tx, { brokerId, positionId: id, adminId: session.adminId }));
  } catch (err) {
    const message = err instanceof PositionActionError ? err.message : "reverse failed";
    const status = message === "position not found" ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }

  if (result.kind === "REVERSE_IN_PLACE") {
    await publishTradingEvent("PositionModified", { position_id: result.position.id, account_id: result.accountId, broker_id: brokerId });
    return NextResponse.json({
      mode: "IN_PLACE",
      positionId: result.position.id,
      oldSide: result.oldSide,
      newSide: result.newSide,
      floatingPnlAtFlip: result.floatingPnlAtFlip?.toString() ?? null,
      mirrorWarning: result.mirrorWarning,
    });
  }

  // CLOSE_REOPEN -- same two mirror hooks + realtime publishes the old
  // route always fired, in the same order (close first, then the new
  // leg's fill) -- see docs/briefs/VYX-MIRROR-V0-BRIEF.md.
  await mirror.onClose(prisma, {
    positionId: result.closedPositionId,
    brokerId,
    closedLots: result.volume,
    sourceVolumeBeforeClose: result.volume,
    closePrice: result.closePrice,
  }).catch((err) => console.error("mirror.onClose failed", err));
  await mirror.onFillPosition(prisma, result.newPosition, result.symbolName).catch((err) => console.error("mirror.onFill failed", err));
  await publishTradingEvent("PositionClosed", { position_id: result.closedPositionId, account_id: result.accountId, broker_id: brokerId });
  await publishTradingEvent("OrderFilled", {
    order_id: result.newPosition.originOrderId,
    account_id: result.accountId,
    broker_id: brokerId,
    price: result.openPrice.toString(),
    volume: result.volume.toString(),
    remaining_volume: "0",
  });

  return NextResponse.json({
    mode: "CLOSE_REOPEN",
    closedPositionId: result.closedPositionId,
    realizedPnl: result.realizedPnl.toString(),
    newPositionId: result.newPosition.id,
    newSide: result.newSide,
    openPrice: result.openPrice.toString(),
  });
}
