import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { peekPendingAdmin2faChallenge, deletePendingAdmin2faChallenge, verifyTotp } from "@/lib/totp";

// The second step for a 2FA-enabled Super Admin, once app/api/admin/login's
// password check returned { requiresTwoFactor: true, pendingToken }.
// Mirrors app/api/trade/login/verify-2fa's identical shape.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const pendingToken = typeof body?.pendingToken === "string" ? body.pendingToken : "";
  const code = typeof body?.code === "string" ? body.code : "";
  if (!pendingToken || !code) {
    return NextResponse.json({ error: "pendingToken and code are required" }, { status: 400 });
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

  if (!verifyTotp(admin.twoFactorSecret, code)) {
    return NextResponse.json({ error: "invalid code" }, { status: 401 });
  }

  await deletePendingAdmin2faChallenge(pendingToken);

  const token = await createSessionToken({
    adminId: admin.id,
    role: admin.role,
    brokerId: admin.brokerId,
  });

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
