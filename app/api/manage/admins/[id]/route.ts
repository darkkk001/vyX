import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  // First precedent in this codebase for blocking self-mutation -- an
  // admin disabling their own account would be an accidental self-lockout
  // (this app has no other admin who could re-enable them without going
  // through the DB directly).
  if (id === session!.adminId) {
    return NextResponse.json({ error: "cannot change your own status" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const status = body?.status === "ACTIVE" || body?.status === "DISABLED" ? body.status : null;
  if (!status) {
    return NextResponse.json({ error: "status must be ACTIVE or DISABLED" }, { status: 400 });
  }

  const existing = await prisma.adminUser.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const admin = await tx.adminUser.update({ where: { id }, data: { status } });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "ADMIN_USER_STATUS_CHANGED",
        entityType: "AdminUser",
        entityId: id,
        oldValue: { status: existing.status },
        newValue: { status: admin.status },
      },
    });
    return admin;
  });

  return NextResponse.json({ id: updated.id, status: updated.status });
}
