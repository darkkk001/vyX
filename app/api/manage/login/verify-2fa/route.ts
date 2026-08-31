import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { peekPendingAdmin2faChallenge, deletePendingAdmin2faChallenge, verifyAdminTwoFactorCode } from "@/lib/totp";

// The second step for a 2FA-enabled Manager/Broker Admin/Support, once
// POST /api/manage/login's password check returned
// { requiresTwoFactor: true, pendingToken }. Mirrors
// app/api/admin/login/verify-2fa's shape (issuePendingAdmin2faChallenge/
// peekPendingAdmin2faChallenge are already generic across every admin
// role, see lib/totp.ts's own comment) plus the same broker-match check
// POST /api/manage/login itself does -- a stolen pendingToken is already
// scoped to one specific adminId, but re-checking x-broker-id here is the
// same defense-in-depth this app already applies at the password step,
// not weakened just because 2FA is in the mix. Accepts either a TOTP
// `code` or a single-use `backupCode` (see lib/totp.ts's
// verifyAdminTwoFactorCode).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const pendingToken = typeof body?.pendingToken === "string" ? body.pendingToken : "";
  const code = typeof body?.code === "string" ? body.code : undefined;
  const backupCode = typeof body?.backupCode === "string" ? body.backupCode : undefined;
  const remember = body?.remember === true;
  if (!pendingToken || (!code && !backupCode)) {
    return NextResponse.json({ error: "pendingToken and code (or backupCode) are required" }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`manage-verify-2fa:${pendingToken}`, 10, 300);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const pending = await peekPendingAdmin2faChallenge(pendingToken);
  if (!pending) {
    return NextResponse.json({ error: "login expired, please sign in again" }, { status: 401 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { id: pending.adminId } });
  const requestBrokerId = request.headers.get("x-broker-id");
  if (
    !admin ||
    admin.status !== "ACTIVE" ||
    !admin.twoFactorEnabled ||
    (admin.role !== "MANAGER" && admin.role !== "BROKER_ADMIN" && admin.role !== "SUPPORT") ||
    !requestBrokerId ||
    admin.brokerId !== requestBrokerId
  ) {
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
    remember,
    { userAgent, ip }
  );
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

  const response = NextResponse.json({ id: admin.id, email: admin.email, role: admin.role, brokerId: admin.brokerId });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(remember));
  return response;
}
