import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, revokeSessionById } from "@/lib/auth";

// Revokes one *other* device's session remotely -- "log out everywhere
// but here" is just calling this for every row except the current one.
// Revoking the current session works too (equivalent to
// POST /api/admin/logout) -- no special-casing needed, since
// revokeSessionById already scopes to this admin only. Mirrors
// DELETE /api/trade/sessions/[id] exactly.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const revoked = await revokeSessionById(session.adminId, id);
  if (!revoked) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  await prisma.auditLog.create({
    data: {
      brokerId: session.brokerId,
      actorAdminId: session.adminId,
      action: "ADMIN_SESSION_REVOKED",
      entityType: "AdminUser",
      entityId: session.adminId,
      newValue: { sessionId: id },
    },
  });

  return NextResponse.json({ ok: true });
}
