import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole, revokeAllAdminSessions } from "@/lib/auth";

// Step 2 (owner 2026-09-30): USR "Reset two-step sign-in (2FA)…". BROKER_ADMIN only, never on yourself (your own 2FA
// is changed in Security, with your own code). Clears the staff member's authenticator secret and backup codes and
// signs them out everywhere; broker staff must have 2FA, so their next sign-in goes straight to setting it up again
// (lib/auth.ts shouldForceAdminTwoFactorSetup). Same-broker staff only. Audited (ADMIN_2FA_RESET).
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  if (id === session!.adminId) {
    return NextResponse.json({ error: "you cannot reset your own two-step sign-in here: change it in Security" }, { status: 403 });
  }
  const target = await prisma.adminUser.findUnique({ where: { id }, select: { id: true, brokerId: true, email: true, twoFactorEnabled: true, twoFactorSecret: true } });
  if (!target || target.brokerId !== brokerId) {
    return NextResponse.json({ error: "staff member not found" }, { status: 404 });
  }
  if (!target.twoFactorEnabled && !target.twoFactorSecret) {
    return NextResponse.json({ error: "this staff member has no two-step sign-in to reset" }, { status: 409 });
  }
  const [, removed] = await prisma.$transaction([
    prisma.adminUser.update({ where: { id: target.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } }),
    prisma.adminBackupCode.deleteMany({ where: { adminId: target.id } }),
    prisma.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "ADMIN_2FA_RESET",
        entityType: "AdminUser",
        entityId: target.id,
        oldValue: { twoFactorEnabled: target.twoFactorEnabled },
        newValue: { email: target.email, twoFactorEnabled: false },
      },
    }),
  ]);
  const revoked = await revokeAllAdminSessions(target.id);
  return NextResponse.json({ adminId: target.id, twoFactorEnabled: false, backupCodesRemoved: removed.count, revoked });
}
