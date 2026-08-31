import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { peekPendingAdmin2faChallenge, deletePendingAdmin2faChallenge, verifyAdminTwoFactorCode } from "@/lib/totp";

// The second step for a 2FA-enabled Super Admin, once app/api/admin/login's
// password check returned { requiresTwoFactor: true, pendingToken }.
// Mirrors app/api/trade/login/verify-2fa's identical shape. Phase 1
// trust pack: accepts either a TOTP `code` or a single-use `backupCode`
// now (see lib/totp.ts's verifyAdminTwoFactorCode) -- same fallback
// app/api/manage/login/verify-2fa offers Manager/Broker Admin/Support.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const pendingToken = typeof body?.pendingToken === "string" ? body.pendingToken : "";
  const code = typeof body?.code === "string" ? body.code : undefined;
  const backupCode = typeof body?.backupCode === "string" ? body.backupCode : undefined;
  if (!pendingToken || (!code && !backupCode)) {
    return NextResponse.json({ error: "pendingToken and code (or backupCode) are required" }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`admin-verify-2fa:${pendingToken}`, 10, 300);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const pending = await peekPendingAdmin2faChallenge(pendingToken);
  if (!pending) {
    return NextResponse.json({ error: "login expired, please sign in again" }, { status: 401 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { id: pending.adminId } });
  if (!admin || admin.status !== "ACTIVE" || !admin.twoFactorEnabled || !admin.twoFactorSecret) {
    await deletePendingAdmin2faChallenge(pendingToken);
    return NextResponse.json({ error: "login expired, please sign in again" }, { status: 401 });
  }

  if (!(await verifyAdminTwoFactorCode(admin, { code, backupCode }))) {
    return NextResponse.json({ error: "invalid code" }, { status: 401 });
  }

  await deletePendingAdmin2faChallenge(pendingToken);

  const userAgent = request.headers.get("user-agent");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const token = await createSessionToken(
    { adminId: admin.id, role: admin.role, brokerId: admin.brokerId },
    false,
    { userAgent, ip }
  );

  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

  const response = NextResponse.json({
    id: admin.id,
    email: admin.email,
    role: admin.role,
    brokerId: admin.brokerId,
  });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  return response;
}
