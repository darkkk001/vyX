import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole, revokeAllAdminSessions } from "@/lib/auth";

// Phase 2 batch 4 (owner decision 2026-09-26): 2FA is mandatory for every
// backoffice staff member, so a staff member who lost their authenticator
// device needs someone to clear it -- the platform super admin. Clears the
// secret + backup codes (twoFactorEnabled false), revokes every session the
// staff member has, and audits it. Their next sign-in is enrolment-only
// (lib/auth.ts's getAdminSession) until they enrol a new device. Broker staff
// only: a super admin's own 2FA is managed on its own Security page.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const admin = await prisma.adminUser.findUnique({ where: { id }, select: { id: true, email: true, role: true, brokerId: true, twoFactorEnabled: true } });
  if (!admin || !admin.brokerId || admin.role === "SUPER_ADMIN") {
    return NextResponse.json({ error: "staff member not found" }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: admin.id }, data: { twoFactorSecret: null, twoFactorEnabled: false } }),
    prisma.adminBackupCode.deleteMany({ where: { adminId: admin.id } }),
    prisma.auditLog.create({
      data: {
        brokerId: admin.brokerId,
        actorAdminId: session!.adminId,
        action: "ADMIN_2FA_RESET_BY_SUPER_ADMIN",
        entityType: "AdminUser",
        entityId: admin.id,
        oldValue: { twoFactorEnabled: admin.twoFactorEnabled },
        newValue: { email: admin.email, twoFactorEnabled: false },
      },
    }),
  ]);
  // Same rule as a password reset: whoever holds a live session loses it now.
  const revokedSessions = await revokeAllAdminSessions(admin.id);

  return NextResponse.json({ ok: true, revokedSessions });
}
