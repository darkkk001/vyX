import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PositionActionError, executeDelete, requestPositionAction, positionActionNeedsApproval } from "@/lib/position-actions";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// True DELETE (VYX-POSITION-TOOLS-V0), distinct from VOID: the row is
// never physically removed -- it's soft-deleted (Position.deletedAt) out
// of the trader-visible statement/history only, fully recoverable from
// the audit view. deletedBy/reason are mandatory, per the brief.
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

  // No realtime publish here -- DELETE is only ever eligible on an
  // already-CLOSED/VOIDED position (see executeDelete's own comment), so
  // no OPEN-position view anywhere needs to react to it.
  return NextResponse.json({ id: result.position.id, deletedAt: result.position.deletedAt });
}
