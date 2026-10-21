import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PositionActionError, executeDelete, requestPositionAction, positionActionNeedsApproval } from "@/lib/position-actions";
import { publishTradingEvent } from "@/lib/nats";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// DELETE (Batch D, owner 2026-10-21): the trade's money is reversed like a void AND the trade and its ledger rows are
// hidden from the client (lib/position-actions.ts executeDelete). Nothing is physically removed; there is no undelete.
// The reason is mandatory. A MANAGER files a request (202); a second request on the same trade is refused (409).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) {
    return NextResponse.json({ error: "a reason is required to delete a position" }, { status: 400 });
  }

  if (positionActionNeedsApproval(session.role as "MANAGER" | "BROKER_ADMIN")) {
    try {
      const created = await prisma.$transaction((tx) =>
        requestPositionAction(tx, { brokerId, positionId: id, adminId: session.adminId, actionType: "DELETE", reason })
      );
      return NextResponse.json({ pending: true, requestId: created.id }, { status: 202 });
    } catch (err) {
      const message = err instanceof PositionActionError ? err.message : "delete request failed";
      return NextResponse.json({ error: message }, { status: 409 });
    }
  }

  let result;
  try {
    result = await prisma.$transaction((tx) => executeDelete(tx, { brokerId, positionId: id, adminId: session.adminId, reason }));
  } catch (err) {
    const message = err instanceof PositionActionError ? err.message : "delete failed";
    const status = message === "position not found" ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }

  // only CLOSED / VOIDED trades are deleted (no open-position view reacts), but a CLOSED trade's money was just reversed
  if (!result.reversalAmount.isZero()) {
    await publishTradingEvent("BalanceChanged", { account_id: result.accountId, broker_id: brokerId }).catch((err) => console.error("BalanceChanged publish failed", err));
  }
  return NextResponse.json({ id: result.position.id, deletedAt: result.position.deletedAt, status: result.position.status, reversalAmount: result.reversalAmount.toString(), hiddenRows: result.hiddenRows });
}
