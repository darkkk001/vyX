import { NextRequest, NextResponse } from "next/server";
import { authenticateClient, createClientSession, CLIENT_SESSION_COOKIE_NAME, clientSessionCookieOptions } from "@/lib/client-auth";
import { checkRateLimit, clearFailures, failureCount, isLockedOut, recordFailure } from "@/lib/rate-limit";
import { humanCheckSiteKey, verifyHumanCheck } from "@/lib/turnstile";
import { prisma } from "@/lib/prisma";
import { verifyTotp } from "@/lib/totp";
import { clientIp } from "@/lib/order-execution";
import { clientIpOf } from "@/lib/demo";

// Three limits, one answer. IP + address stops guessing at one account from one place; the IP limit stops one place
// walking through many accounts; the failure count stops many places guessing at one account. All of them count unknown
// addresses too, so a refusal says nothing about whether an address is registered.
const PER_IP_AND_ADDRESS_PER_MINUTE = 5;
const PER_IP_PER_MINUTE = 30;
const FAILURES_PER_ADDRESS = 20;
const FAILURE_WINDOW_SECONDS = 15 * 60;
// Failures from this IP, or on this address, before the sign-in asks for the human check.
const HUMAN_CHECK_AFTER_FAILURES = 3;

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

  const ip = clientIpOf(request.headers);
  const failures = `portal-login:${brokerId}:${email}`;
  const [byIp, byIpAndAddress, locked] = await Promise.all([
    checkRateLimit(`portal-login-ip:${brokerId}:${ip}`, PER_IP_PER_MINUTE, 60),
    checkRateLimit(`portal-login:${brokerId}:${email}:${ip}`, PER_IP_AND_ADDRESS_PER_MINUTE, 60),
    isLockedOut(failures, FAILURES_PER_ADDRESS),
  ]);
  if (!byIp.allowed || !byIpAndAddress.allowed || locked) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const ipFailures = `portal-login-ip:${brokerId}:${ip}`;
  const siteKey = await humanCheckSiteKey(brokerId);
  if (siteKey) {
    const [onAddress, onIp] = await Promise.all([failureCount(failures), failureCount(ipFailures)]);
    if (Math.max(onAddress, onIp) >= HUMAN_CHECK_AFTER_FAILURES && (await verifyHumanCheck(body?.turnstileToken, clientIp(request.headers))) === "bad") {
      return NextResponse.json({ error: "complete the check to continue", code: "HUMAN_CHECK_REQUIRED", siteKey }, { status: 401 });
    }
  }

  const client = await authenticateClient(brokerId, email, password);
  if (!client) {
    await Promise.all([recordFailure(failures, FAILURE_WINDOW_SECONDS), recordFailure(ipFailures, FAILURE_WINDOW_SECONDS)]);
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
    if (!verifyTotp(client.twoFactorSecret, code)) {
      await Promise.all([recordFailure(failures, FAILURE_WINDOW_SECONDS), recordFailure(ipFailures, FAILURE_WINDOW_SECONDS)]);
      return NextResponse.json({ error: "wrong code", code: "TWO_FACTOR_INVALID" }, { status: 401 });
    }
  }
  await clearFailures(failures);

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
