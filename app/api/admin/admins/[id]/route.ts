import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";

async function requireSuperAdmin() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    return null;
  }
  return session;
}

// Status-only, same convention as app/api/manage/admins/[id] (the
// broker-scoped equivalent this mirrors): never hard-delete an AdminUser,
// disable it. Used by the Tenant Detail modal's "Remove admin" action.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSuperAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const status = body?.status === "ACTIVE" || body?.status === "DISABLED" ? body.status : null;
  if (!status) {
    return NextResponse.json({ error: "status must be ACTIVE or DISABLED" }, { status: 400 });
  }

  const existing = await prisma.adminUser.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const admin = await tx.adminUser.update({ where: { id }, data: { status } });
    await tx.auditLog.create({
      data: {
        brokerId: existing.brokerId,
        actorAdminId: session.adminId,
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
