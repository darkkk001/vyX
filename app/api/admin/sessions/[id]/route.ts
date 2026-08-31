import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole, revokeAdminSessionById } from "@/lib/auth";

// Revokes one *other* device's session remotely -- "sign out everywhere
// but here" is just calling this for every row except the current one,
// same convention as app/api/trade/sessions/[id]'s trader twin. Revoking
// the current session works too (equivalent to POST /api/admin/logout,
// minus clearing this browser's own cookie) -- no special-casing needed,
// revokeAdminSessionById already scopes to this admin only.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN", "MANAGER", "BROKER_ADMIN", "SUPPORT"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const revoked = await revokeAdminSessionById(session!.adminId, id);
  if (!revoked) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  await prisma.auditLog.create({
    data: {
      brokerId: session!.brokerId,
      actorAdminId: session!.adminId,
      action: "ADMIN_SESSION_REVOKED",
      entityType: "AdminUser",
      entityId: session!.adminId,
      oldValue: {},
      newValue: { sessionId: id },
    },
  });

  return NextResponse.json({ ok: true });
}
