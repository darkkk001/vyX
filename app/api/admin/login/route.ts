import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth";
import { issuePendingAdmin2faChallenge } from "@/lib/totp";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  // Every other login route in the app (trade, manage) is rate-limited;
  // this one -- the platform root, with no per-broker scope to narrow
  // the key to -- had none, meaning unlimited online brute force against
  // it. Same 5/min shape as the others.
  const { allowed } = await checkRateLimit(`admin-login:${email}`, 5, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });

  // Constant-shape response whether the email exists or not, to avoid
  // leaking which admin emails are registered.
  if (!admin || admin.status !== "ACTIVE") {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
  if (!passwordMatches) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  // Password alone isn't enough once 2FA is turned on (see
  // AdminUser.twoFactorEnabled's schema comment) -- issue a short-lived
  // pending challenge instead of a real session; POST
  // /api/admin/login/verify-2fa is the only thing that can turn it into
  // one. Mirrors app/api/trade/login's identical gate for traders.
  if (admin.twoFactorEnabled) {
    const pendingToken = await issuePendingAdmin2faChallenge({ adminId: admin.id });
    return NextResponse.json({ requiresTwoFactor: true, pendingToken });
  }

  const token = await createSessionToken({
    adminId: admin.id,
    role: admin.role,
    brokerId: admin.brokerId,
  });

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  const response = NextResponse.json({
    id: admin.id,
    email: admin.email,
    role: admin.role,
    brokerId: admin.brokerId,
  });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  return response;
}
