import { NextRequest, NextResponse } from "next/server";
import { authenticateClient, createClientSession, CLIENT_SESSION_COOKIE_NAME, clientSessionCookieOptions } from "@/lib/client-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { verifyTotp } from "@/lib/totp";
import { clientIp } from "@/lib/order-execution";

// Client Portal login -- email + password, distinct from the trader
// account-number login (app/api/trade/login) this doesn't touch or
// replace. Refuses an unverified email outright, same "can't do
// anything until you verify" rule Exness/XM both use.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const remember = body?.remember !== false;

  const { allowed } = await checkRateLimit(`portal-login:${brokerId}:${email}`, 5, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const client = await authenticateClient(brokerId, email, password);
  if (!client) {
    return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
  }
  if (!client.emailVerifiedAt) {
    return NextResponse.json({ error: "please verify your email before logging in, check your inbox" }, { status: 403 });
  }

  // Trader's Room 2FA (2026-11-03): a client who turned it on sends the 6-digit code with the password; without a valid
  // one no session is made. Only the Trader's Room can turn it on, so the portal's own form never meets this.
  if (client.twoFactorEnabled && client.twoFactorSecret) {
    const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
    if (!code) return NextResponse.json({ error: "enter the code from your authenticator app", code: "TWO_FACTOR_REQUIRED" }, { status: 401 });
    if (!verifyTotp(client.twoFactorSecret, code)) return NextResponse.json({ error: "wrong code", code: "TWO_FACTOR_INVALID" }, { status: 401 });
  }

  const token = await createClientSession({ clientId: client.id, brokerId }, remember, { userAgent: request.headers.get("user-agent"), ip: clientIp(request.headers) });
  // Trader's Room "Last login": the previous sign-in moves down one slot (best effort, never blocks a login)
  await prisma.client
    .update({ where: { id: client.id }, data: { prevLoginAt: client.lastLoginAt, lastLoginAt: new Date() } })
    .catch((err) => console.error("[portal-login] login time update failed", err));

  const response = NextResponse.json({
    clientId: client.id,
    email: client.email,
    fullName: client.fullName,
  });
  response.cookies.set(CLIENT_SESSION_COOKIE_NAME, token, await clientSessionCookieOptions(remember));
  return response;
}
