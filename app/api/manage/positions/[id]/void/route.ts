import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import * as mirror from "@/lib/mirror";
import { publishTradingEvent } from "@/lib/nats";
import { PositionActionError, executeVoid, requestPositionAction, positionActionNeedsApproval } from "@/lib/position-actions";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Void, redefined (VYX-POSITION-TOOLS-V0): cancels ANY open position as
// if it produced no P/L -- balance restored to pre-open state via a
// ledger reversal entry, position marked VOIDED (admin-visible, hidden
// from the trader's statement -- that's already true today since
// app/api/trade/history's own query only ever selects status: "CLOSED").
// No longer restricted to manually-opened positions -- see
// lib/position-actions.ts's executeVoid for the full reversal math.
// MANAGER's call only ever creates a PENDING PositionActionRequest.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  if (positionActionNeedsApproval(session.role as "MANAGER" | "BROKER_ADMIN")) {
    try {
      const created = await prisma.$transaction((tx) =>
        requestPositionAction(tx, { brokerId, positionId: id, adminId: session.adminId, actionType: "VOID", reason: null })
      );
      return NextResponse.json({ pending: true, requestId: created.id }, { status: 202 });
    } catch (err) {
      const message = err instanceof PositionActionError ? err.message : "void request failed";
      return NextResponse.json({ error: message }, { status: 409 });
    }
  }

  let result;
  try {
    result = await prisma.$transaction((tx) => executeVoid(tx, { brokerId, positionId: id, adminId: session.adminId }));
  } catch (err) {
    const message = err instanceof PositionActionError ? err.message : "void failed";
    const status = message === "position not found" ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }

  // Same corollaries the old route already carried: unwind a mirrored
  // target that was following this position, and let the backoffice
  // Positions/Exposure views stop counting it as open.
  await mirror.onClose(prisma, {
    positionId: id,
    brokerId,
    closedLots: result.position.volume,
    sourceVolumeBeforeClose: result.position.volume,
  }).catch((err) => console.error("mirror.onClose failed", err));
  await publishTradingEvent("PositionClosed", { position_id: id, account_id: result.accountId, broker_id: brokerId });

  return NextResponse.json({
    id: result.position.id,
    status: result.position.status,
    reversalAmount: result.reversalAmount.toString(),
    balanceAfter: result.balanceAfter.toString(),
  });
}
