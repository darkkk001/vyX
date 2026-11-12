import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { roomBroker } from "@/lib/room/context";
import { verifyTotp } from "@/lib/totp";
import { clearFailures, isLockedOut, recordFailure } from "@/lib/rate-limit";
import { GOOGLE_2FA_COOKIE, GOOGLE_2FA_MAX_TRIES, google2faKey } from "@/lib/room/google-login";
import { clearGoogleCookies, googleSignIn } from "@/lib/room/google-session";

// The 2FA step after Google (the callback left a ticket for this browser): the authenticator code, then the session.
// Wrong codes count toward the same per-address lockout as the password sign-in, and the ticket ends after 5.
const FAILURES_PER_ADDRESS = 20;
const FAILURE_WINDOW_SECONDS = 15 * 60;

export async function POST(request: NextRequest) {
  const expired = () => clearGoogleCookies(NextResponse.json({ error: "That Google sign-in expired. Try again.", code: "EXPIRED" }, { status: 401 }));
  const broker = await roomBroker();
  const ticket = request.cookies.get(GOOGLE_2FA_COOKIE)?.value ?? "";
  if (!broker || !ticket) return expired();
  const redis = getRedis();
  const raw = await redis.get(google2faKey(ticket));
  if (!raw) return expired();
  const t = JSON.parse(raw) as { clientId: string; brokerId: string; remember: boolean; tries: number };
  if (t.brokerId !== broker.id) return expired();
  const client = await prisma.client.findUnique({ where: { id: t.clientId } });
  if (!client || client.status !== "ACTIVE" || !client.twoFactorEnabled || !client.twoFactorSecret) { await redis.del(google2faKey(ticket)); return expired(); }

  const failures = `portal-login:${broker.id}:${client.email}`;
  if (await isLockedOut(failures, FAILURES_PER_ADDRESS)) return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
  if (!verifyTotp(client.twoFactorSecret, code)) {
    await recordFailure(failures, FAILURE_WINDOW_SECONDS);
    if (t.tries + 1 >= GOOGLE_2FA_MAX_TRIES) { await redis.del(google2faKey(ticket)); return expired(); }
    await redis.set(google2faKey(ticket), JSON.stringify({ ...t, tries: t.tries + 1 }), "KEEPTTL");
    return NextResponse.json({ error: "Wrong code. Try the next one.", code: "TWO_FACTOR_INVALID" }, { status: 401 });
  }
  // used once
  if (!(await redis.getdel(google2faKey(ticket)))) return expired();
  await clearFailures(failures);
  return googleSignIn(request, client, broker.id, t.remember, NextResponse.json({ ok: true }));
}
