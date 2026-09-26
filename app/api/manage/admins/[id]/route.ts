import { NextRequest, NextResponse } from "next/server";
import { withConfigEvent } from "@/lib/config-events";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole, revokeAllAdminSessions } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";

async function patchHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  // First precedent in this codebase for blocking self-mutation -- an
  // admin disabling their own account would be an accidental self-lockout
  // (this app has no other admin who could re-enable them without going
  // through the DB directly). Phase 2 batch 4: the same rule covers a role
  // change (no demoting yourself out of Team access).
  if (id === session!.adminId) {
    return NextResponse.json({ error: "you cannot change your own access or role" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const hasStatusChange = body != null && "status" in body;
  const hasPermissionsChange = body != null && "extraPermissions" in body;
  const hasRoleChange = body != null && "role" in body;
  if (!hasStatusChange && !hasPermissionsChange && !hasRoleChange) {
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

  // Phase 2 batch 4 (owner decision): a BROKER_ADMIN changes a staff member's
  // role between the three broker staff roles -- never to or from SUPER_ADMIN
  // (a platform role, not the broker's to hand out or take away).
  let role: "BROKER_ADMIN" | "MANAGER" | "SUPPORT" | undefined;
  if (hasRoleChange) {
    if (body.role !== "BROKER_ADMIN" && body.role !== "MANAGER" && body.role !== "SUPPORT") {
      return NextResponse.json({ error: "role must be BROKER_ADMIN, MANAGER or SUPPORT" }, { status: 400 });
    }
    role = body.role;
  }

  const existing = await prisma.adminUser.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId || existing.role === "SUPER_ADMIN") {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }
  const roleChanging = role !== undefined && role !== existing.role;
  const finalRole = role ?? existing.role;
  // Only MANAGER-role admins can hold delegated permissions --
  // BROKER_ADMIN already has everything implicitly, SUPPORT is read-only.
  if (extraPermissions !== undefined && finalRole !== "MANAGER") {
    return NextResponse.json({ error: "extraPermissions only applies to MANAGER-role admins" }, { status: 400 });
  }

  type Outcome = { ok: true; admin: Awaited<ReturnType<typeof prisma.adminUser.update>> } | { ok: false; error: string };
  const outcome: Outcome = await prisma.$transaction(async (tx) => {
    // Keep at least one ACTIVE BROKER_ADMIN at this broker: demoting or
    // disabling one is refused when no other active one would remain (checked
    // inside the transaction, so two admins demoting each other at once can't
    // both pass). The caller is itself an active BROKER_ADMIN and can't target
    // itself, so today this can only trip on stale data -- it is the rule, not
    // an accident of the self-check, that guarantees it.
    const losesBrokerAdmin = existing.role === "BROKER_ADMIN" && existing.status === "ACTIVE" && ((roleChanging && finalRole !== "BROKER_ADMIN") || status === "DISABLED");
    if (losesBrokerAdmin) {
      const others = await tx.adminUser.count({ where: { brokerId, role: "BROKER_ADMIN", status: "ACTIVE", id: { not: id } } });
      if (others < 1) return { ok: false, error: "the broker must keep at least one active broker admin" };
    }
    const admin = await tx.adminUser.update({
      where: { id },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(roleChanging ? { role: finalRole } : {}),
        // a role change away from MANAGER drops the delegations (they only mean anything on MANAGER)
        ...(extraPermissions !== undefined ? { extraPermissions } : roleChanging && finalRole !== "MANAGER" ? { extraPermissions: [] } : {}),
      },
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
    if (roleChanging) {
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "ADMIN_ROLE_CHANGED",
          entityType: "AdminUser",
          entityId: id,
          oldValue: { role: existing.role, extraPermissions: existing.extraPermissions },
          newValue: { role: admin.role, extraPermissions: admin.extraPermissions },
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
    return { ok: true, admin };
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 409 });
  }
  const updated = outcome.admin;

  // A disabled admin, or one whose role changed, loses every live session now
  // (getAdminSession already refuses a session whose role no longer matches;
  // this also clears them from Redis instead of leaving them to expire).
  if (roleChanging || updated.status === "DISABLED") {
    await revokeAllAdminSessions(id);
  }

  return NextResponse.json({ id: updated.id, role: updated.role, status: updated.status, extraPermissions: updated.extraPermissions });
}

// Batch 5 (real-time): a successful write announces the change to every open client (lib/config-events.ts)
export const PATCH = withConfigEvent("permissions", patchHandler);
