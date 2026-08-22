import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

// Mirrors app/api/trade/two-factor/disable -- requires re-entering the
// current password, same as disabling 2FA anywhere else, so a Super
// Admin who stepped away from an already-unlocked session can't have
// this turned off by whoever's now at the keyboard.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { allowed } = await checkRateLimit(`admin-2fa-disable:${session!.adminId}`, 10, 300);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  const admin = await prisma.adminUser.findUnique({ where: { id: session!.adminId } });
  if (!admin) {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }
  if (!admin.twoFactorEnabled) {
    return NextResponse.json({ error: "2FA is not enabled" }, { status: 409 });
  }

  const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
  if (!passwordMatches) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: admin.id }, data: { twoFactorSecret: null, twoFactorEnabled: false } }),
    prisma.auditLog.create({
      data: {
        brokerId: admin.brokerId,
        actorAdminId: admin.id,
        action: "SUPER_ADMIN_2FA_DISABLED",
        entityType: "AdminUser",
        entityId: admin.id,
        oldValue: {},
        newValue: {},
      },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
