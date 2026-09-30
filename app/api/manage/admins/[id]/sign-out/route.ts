import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole, revokeAllAdminSessions } from "@/lib/auth";

// Step 2 (owner 2026-09-30): USR "Sign out everywhere…". Ends every session of another staff member of this broker.
// BROKER_ADMIN only, never on yourself (your own devices are signed out from Security). Audited
// (ADMIN_SESSIONS_REVOKED) before the revoke.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  if (id === session!.adminId) {
    return NextResponse.json({ error: "you cannot sign yourself out here: use Security" }, { status: 403 });
  }
  const target = await prisma.adminUser.findUnique({ where: { id }, select: { id: true, brokerId: true, email: true } });
  if (!target || target.brokerId !== brokerId) {
    return NextResponse.json({ error: "staff member not found" }, { status: 404 });
  }
  await prisma.auditLog.create({
    data: { brokerId, actorAdminId: session!.adminId, action: "ADMIN_SESSIONS_REVOKED", entityType: "AdminUser", entityId: target.id, newValue: { email: target.email } },
  });
  const revoked = await revokeAllAdminSessions(target.id);
  return NextResponse.json({ adminId: target.id, revoked });
}
