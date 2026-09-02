import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { verifyTotp, generateBackupCodes, hashBackupCode } from "@/lib/totp";
import { checkRateLimit } from "@/lib/rate-limit";

// Mirrors app/api/trade/two-factor/confirm -- proves the admin actually
// scanned the QR / entered the secret correctly before 2FA starts gating
// login. Phase 1 trust pack: widened from SUPER_ADMIN-only (see
// .../setup's own comment), and now also issues 6 backup codes the
// moment 2FA actually turns on -- returned in plaintext exactly once
// here, never retrievable again (only codeHash is stored, see
// AdminBackupCode's schema comment). Re-confirming after a fresh
// .../setup call (2FA replaced, not first-time) issues a fresh set and
// silently invalidates the old ones (deleted, not just left stale) --
// codes from a secret that no longer exists must not keep working.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN", "MANAGER", "BROKER_ADMIN", "SUPPORT"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { allowed } = await checkRateLimit(`admin-2fa-confirm:${session!.adminId}`, 10, 300);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";

  const admin = await prisma.adminUser.findUnique({ where: { id: session!.adminId } });
  if (!admin?.twoFactorSecret) {
    return NextResponse.json({ error: "no 2FA setup in progress" }, { status: 409 });
  }
  if (admin.twoFactorEnabled) {
    return NextResponse.json({ error: "2FA is already enabled" }, { status: 409 });
  }

  if (!verifyTotp(admin.twoFactorSecret, code)) {
    return NextResponse.json({ error: "invalid code" }, { status: 401 });
  }

  const backupCodes = generateBackupCodes();
  const codeHashes = await Promise.all(backupCodes.map(hashBackupCode));

  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: admin.id }, data: { twoFactorEnabled: true } }),
    prisma.adminBackupCode.deleteMany({ where: { adminId: admin.id } }),
    prisma.adminBackupCode.createMany({ data: codeHashes.map((codeHash) => ({ adminId: admin.id, codeHash })) }),
    prisma.auditLog.create({
      data: {
        brokerId: admin.brokerId,
        actorAdminId: admin.id,
        action: "ADMIN_2FA_ENABLED",
        entityType: "AdminUser",
        entityId: admin.id,
        oldValue: {},
        newValue: {},
      },
    }),
  ]);

  return NextResponse.json({ ok: true, backupCodes });
}
