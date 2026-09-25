import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import * as mirror from "@/lib/mirror";
import { publishTradingEvent } from "@/lib/nats";
import { approvePositionActionRequest } from "@/lib/position-actions";

// The checker half of the maker-checker gate: an admin holding the same
// finance authority the maker needed (BROKER_ADMIN, or a MANAGER with
// ACCOUNT_FINANCE) EXCEPT the one who requested it (see
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
  // Pentest 2026-09-18 #3: the checker used to need only the MANAGER role,
  // so a manager with no finance permission at all could release a pending
  // adjustment it could never have filed -- four-eyes was one finance
  // signature plus anyone. Real four-eyes is two finance signatures.
  if (await forbidUnlessBrokerAdminOrPermission(session, "ACCOUNT_FINANCE")) {
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
      for (const f of execResult.followers) await publishTradingEvent("PositionModified", { position_id: f.positionId, account_id: f.accountId, broker_id: brokerId }).catch(() => {});
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
