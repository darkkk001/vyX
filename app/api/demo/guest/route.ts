import { NextRequest, NextResponse } from "next/server";
import { ACCOUNT_SESSION_COOKIE_NAME, accountSessionCookieOptions, completeAccountLogin, getAccountSession } from "@/lib/account-auth";
import { clientIpOf, createGuestAccount, getDemoBrokerId, GUEST_GLOBAL_PER_HOUR, GUEST_PER_IP_PER_HOUR, writeDemoState } from "@/lib/demo";
import { isDemoTenant } from "@/lib/demo-policy";
import { checkRateLimit } from "@/lib/rate-limit";

// POST /api/demo/guest -- the QoreTrader demo's only way in. Creates one throwaway DEMO account (10,000 USD, the demo
// broker's default group, no password anyone knows) and signs the visitor into it. Exists for the demo tenant alone: on any
// other host it answers 404, exactly as if the route were not there.
//
// Abuse limits (owner 2026-10-12): GUEST_PER_IP_PER_HOUR new guests per address per hour, GUEST_GLOBAL_PER_HOUR in total per
// hour. The address is the one Vercel itself sets (lib/demo.ts clientIpOf: x-real-ip, never x-forwarded-for). A visitor who
// already holds a valid demo session gets that session back and costs no new account.
export async function POST(request: NextRequest) {
  if (!isDemoTenant(request.headers.get("x-broker-slug"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // the slug header alone could be forged on a host with no broker resolution: the broker id must be the demo broker's too
  const demoBrokerId = await getDemoBrokerId();
  if (!demoBrokerId || request.headers.get("x-broker-id") !== demoBrokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const existing = await getAccountSession();
  if (existing) return NextResponse.json({ ok: true, existing: true, serverNow: Date.now() });

  const ip = clientIpOf(request.headers);
  const perIp = await checkRateLimit(`demo-guest:ip:${ip}`, GUEST_PER_IP_PER_HOUR, 3600);
  if (!perIp.allowed) {
    return NextResponse.json({ error: "Too many demo accounts from this address. Try again in an hour." }, { status: 429, headers: { "Retry-After": "3600" } });
  }
  const global = await checkRateLimit("demo-guest:global", GUEST_GLOBAL_PER_HOUR, 3600);
  if (!global.allowed) {
    return NextResponse.json({ error: "The demo is busy. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "600" } });
  }

  const guest = await createGuestAccount();
  if (!guest) {
    return NextResponse.json({ error: "The demo is not available right now." }, { status: 503 });
  }
  await writeDemoState(guest.id, { t: Date.now(), w: 0 });

  const token = await completeAccountLogin(
    { id: guest.id, brokerId: guest.brokerId },
    null,
    { userAgent: request.headers.get("user-agent"), ip: ip === "unknown" ? null : ip },
    true
  );
  const response = NextResponse.json({ ok: true, existing: false, serverNow: Date.now() });
  response.cookies.set(ACCOUNT_SESSION_COOKIE_NAME, token, await accountSessionCookieOptions(true));
  return response;
}
