import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";

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
  const hasStatusChange = body != null && "status" in body;
  const hasPermissionsChange = body != null && "extraPermissions" in body;
  if (!hasStatusChange && !hasPermissionsChange) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  let status: "ACTIVE" | "DISABLED" | undefined;
  if (hasStatusChange) {
    if (body.status !== "ACTIVE" && body.status !== "DISABLED") {
      return NextResponse.json({ error: "status must be ACTIVE or DISABLED" }, { status: 400 });
    }
    status = body.status;
  }

  let extraPermissions: string[] | undefined;
  if (hasPermissionsChange) {
    if (!Array.isArray(body.extraPermissions) || !body.extraPermissions.every((p: unknown) => typeof p === "string" && (PERMISSIONS as readonly string[]).includes(p))) {
      return NextResponse.json({ error: `extraPermissions must only contain: ${PERMISSIONS.join(", ")}` }, { status: 400 });
    }
    extraPermissions = [...new Set(body.extraPermissions as string[])];
  }

  const existing = await prisma.adminUser.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }
  // Only MANAGER-role admins can hold delegated permissions --
  // BROKER_ADMIN already has everything implicitly, SUPPORT has no
  // login route.
  if (extraPermissions !== undefined && existing.role !== "MANAGER") {
    return NextResponse.json({ error: "extraPermissions only applies to MANAGER-role admins" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const admin = await tx.adminUser.update({
      where: { id },
      data: { ...(status !== undefined ? { status } : {}), ...(extraPermissions !== undefined ? { extraPermissions } : {}) },
    });
    if (status !== undefined) {
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
    }
    if (extraPermissions !== undefined) {
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "PERMISSIONS_CHANGED",
          entityType: "AdminUser",
          entityId: id,
          oldValue: { extraPermissions: existing.extraPermissions },
          newValue: { extraPermissions: admin.extraPermissions },
        },
      });
    }
    return admin;
  });

  return NextResponse.json({ id: updated.id, status: updated.status, extraPermissions: updated.extraPermissions });
}
