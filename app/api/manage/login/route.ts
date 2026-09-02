import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

// Manager's own login route, not app/api/admin/login/route.ts — that one
// has no broker-match check (fine for Super Admin, which always runs on
// admin.<ROOT_DOMAIN> with no x-broker-id ever set) but wrong here: an
// admin from Broker A's team must not be able to log in on Broker B's
// subdomain even with correct credentials, since Manager lives on the
// broker's own subdomain (middleware.ts already resolves x-broker-id for
// it normally, unlike admin.<ROOT_DOMAIN>). Rather than risk changing
// Super Admin's login behavior, this is a separate route with the extra
// check baked in.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const remember = body?.remember === true;

  if (!email || !password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const requestBrokerId = request.headers.get("x-broker-id");

  // Same throttle as the trade-login route (5/min per broker+identifier) --
  // the people who can adjust balances and approve withdrawals had a
  // less-protected login than the traders themselves, with no rate limit
  // on it at all before this.
  const { allowed } = await checkRateLimit(`manage-login:${requestBrokerId ?? "none"}:${email}`, 5, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });

  // Constant-shape response for every failure reason (no account, wrong
  // password, wrong role, wrong broker) — same "don't leak which emails
  // are registered" rule as app/api/admin/login/route.ts, extended here
  // to also not leak "that email exists but isn't a manager for this
  // broker."
  const invalid = () => NextResponse.json({ error: "invalid credentials" }, { status: 401 });

  if (!admin || admin.status !== "ACTIVE") {
    return invalid();
  }
  if (admin.role !== "MANAGER" && admin.role !== "BROKER_ADMIN") {
    return invalid();
  }
  if (!requestBrokerId || admin.brokerId !== requestBrokerId) {
    return invalid();
  }

  const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
  if (!passwordMatches) {
    return invalid();
  }

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
