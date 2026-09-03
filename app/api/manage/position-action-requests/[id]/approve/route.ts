import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import * as mirror from "@/lib/mirror";
import { publishTradingEvent } from "@/lib/nats";
import { approvePositionActionRequest } from "@/lib/position-actions";

// The checker half of the maker-checker gate: any admin who can act on
// positions EXCEPT the one who requested it (see
// approvePositionActionRequest's own different-admin check) approves,
// which is the moment the action actually executes -- a PENDING request
// has no effect on the position at all until this. Runs the exec + the
// mark-approved write in one transaction (same shape as the direct-
// execute routes), then fires the same post-commit mirror/realtime
// hooks those routes fire, branching on which action type actually ran.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const reviewNote = typeof body?.reviewNote === "string" ? body.reviewNote.trim().slice(0, 500) || null : null;

  const result = await prisma.$transaction((tx) =>
    approvePositionActionRequest(tx, { requestId: id, brokerId, adminId: session!.adminId, reviewNote })
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  const { execResult } = result;
  switch (execResult.kind) {
    case "REVERSE_IN_PLACE":
      await publishTradingEvent("PositionModified", { position_id: execResult.position.id, account_id: execResult.accountId, broker_id: brokerId });
      break;
    case "REVERSE_CLOSE_REOPEN":
      await mirror
        .onClose(prisma, {
          positionId: execResult.closedPositionId,
          brokerId,
          closedLots: execResult.volume,
          sourceVolumeBeforeClose: execResult.volume,
          closePrice: execResult.closePrice,
        })
        .catch((err) => console.error("mirror.onClose failed", err));
      await mirror.onFillPosition(prisma, execResult.newPosition, execResult.symbolName).catch((err) => console.error("mirror.onFill failed", err));
      await publishTradingEvent("PositionClosed", { position_id: execResult.closedPositionId, account_id: execResult.accountId, broker_id: brokerId });
      await publishTradingEvent("OrderFilled", {
        order_id: execResult.newPosition.originOrderId,
        account_id: execResult.accountId,
        broker_id: brokerId,
        price: execResult.openPrice.toString(),
        volume: execResult.volume.toString(),
        remaining_volume: "0",
      });
      break;
    case "VOID":
      await mirror
        .onClose(prisma, { positionId: execResult.position.id, brokerId, closedLots: execResult.position.volume, sourceVolumeBeforeClose: execResult.position.volume })
        .catch((err) => console.error("mirror.onClose failed", err));
      await publishTradingEvent("PositionClosed", { position_id: execResult.position.id, account_id: execResult.accountId, broker_id: brokerId });
      break;
    case "DELETE":
      // No realtime publish -- DELETE is only ever eligible on an
      // already-CLOSED/VOIDED position (see executeDelete's own
      // comment), so no OPEN-position view needs to react to it.
      break;
  }

  return NextResponse.json({ requestId: result.requestId, actionType: execResult.kind });
}
