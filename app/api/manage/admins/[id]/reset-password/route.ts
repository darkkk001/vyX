import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole, revokeAllAdminSessions } from "@/lib/auth";
import { generateTemporaryPassword } from "@/lib/passwords";

// Phase 2 batch 4 (owner decision 2026-09-26, audit lines 163 / 180): the
// broker side of a staff member's "Forgot password?" -- before this only the
// platform super admin could reset a staff password, while the
// ADMIN_PASSWORD_RESET_REQUESTED notification went to the broker's own staff.
// A BROKER_ADMIN resets another staff member of the SAME broker: a one-time
// temporary password is generated server-side and returned exactly once (never
// stored in plaintext, never retrievable again), every session of that staff
// member is revoked, the reset is audited, and the open reset-request
// notifications for them are marked handled. Not your own password (a password
// you know is changed by you, not reset), and never a SUPER_ADMIN.
//
// Not added (would need a migration): a "must change password at next sign-in"
// flag -- the temporary password stays valid until the staff member changes it.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  if (id === session!.adminId) {
    return NextResponse.json({ error: "you cannot reset your own password here" }, { status: 400 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { id }, select: { id: true, email: true, role: true, brokerId: true, status: true } });
  if (!admin || admin.brokerId !== brokerId || admin.role === "SUPER_ADMIN") {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }

  const password = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } }),
    prisma.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "ADMIN_PASSWORD_RESET_BY_BROKER_ADMIN",
        entityType: "AdminUser",
        entityId: admin.id,
        newValue: { email: admin.email, role: admin.role },
      },
    }),
    // the reset request(s) this answers are handled now
    prisma.notification.updateMany({
      where: { brokerId, type: "ADMIN_PASSWORD_RESET_REQUESTED", entityType: "AdminUser", entityId: admin.id, readAt: null },
      data: { readAt: new Date() },
    }),
  ]);
  // Same rule as a super-admin reset (pentest 2026-09-18 #2): sessions opened
  // with the old password die now, not at their 7/30-day TTL.
  const revokedSessions = await revokeAllAdminSessions(admin.id);

  return NextResponse.json({ id: admin.id, email: admin.email, password, revokedSessions });
}
