import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth";

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

  const token = await createSessionToken({ adminId: admin.id, role: admin.role, brokerId: admin.brokerId }, remember);

  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

  const response = NextResponse.json({ id: admin.id, email: admin.email, role: admin.role, brokerId: admin.brokerId });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(remember));
  return response;
}
