import { NextRequest, NextResponse } from "next/server";
import { authenticateClient, createClientSession, CLIENT_SESSION_COOKIE_NAME, clientSessionCookieOptions } from "@/lib/client-auth";
import { checkRateLimit } from "@/lib/rate-limit";

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
    return NextResponse.json({ error: "please verify your email before logging in -- check your inbox" }, { status: 403 });
  }

  const token = await createClientSession({ clientId: client.id, brokerId }, remember);

  const response = NextResponse.json({
    clientId: client.id,
    email: client.email,
    fullName: client.fullName,
  });
  response.cookies.set(CLIENT_SESSION_COOKIE_NAME, token, await clientSessionCookieOptions(remember));
  return response;
}
