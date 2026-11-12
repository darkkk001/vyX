import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { requestOrigin } from "@/lib/request-origin";
import { roomBroker } from "@/lib/room/context";
import {
  GOOGLE_2FA_COOKIE, GOOGLE_2FA_SECONDS, GOOGLE_CALLBACK_PATH, GOOGLE_COOKIE_PATH, GOOGLE_STATE_COOKIE, checkIdToken, exchangeCode, google2faKey,
  googleAttemptKey, googleClient, googleLoginEnabledFor, randomToken, type GoogleResult,
} from "@/lib/room/google-login";
import { clearGoogleCookies, googleSignIn } from "@/lib/room/google-session";

// Google sends the browser back here (lib/room/google-login.ts). Outcomes:
//   existing ACTIVE client with that email, Google says verified -> signed in (or asked for the 2FA code first)
//   no client with that email                                    -> /register with the email filled in
//   anything else                                                -> /login with a short line
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const back = (r: GoogleResult) => clearGoogleCookies(NextResponse.redirect(`${origin}/login?google=${r}`, 303));
  const broker = await roomBroker();
  const client = googleClient();
  if (!broker || !client || !googleLoginEnabledFor(broker.subdomain)) return clearGoogleCookies(NextResponse.redirect(`${origin}/login`, 303));

  const q = request.nextUrl.searchParams;
  const state = q.get("state") ?? "";
  const cookieState = request.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? "";
  // the attempt is used once, whatever happens next
  const saved = state ? await getRedis().getdel(googleAttemptKey(state)) : null;
  if (q.get("error")) return back("cancelled");
  if (!saved || !cookieState || cookieState.length !== state.length || !crypto.timingSafeEqual(Buffer.from(cookieState), Buffer.from(state))) return back("expired");
  const attempt = JSON.parse(saved) as { brokerId: string; nonce: string; verifier: string; remember: boolean };
  if (attempt.brokerId !== broker.id) return back("expired");
  const code = q.get("code");
  if (!code) return back("failed");

  const idToken = await exchangeCode(client, code, `${origin}${GOOGLE_CALLBACK_PATH}`, attempt.verifier);
  const who = idToken ? checkIdToken(idToken, client.id, attempt.nonce) : null;
  if (!who) return back("failed");
  if (!who.emailVerified) return back("unverified");

  const found = await prisma.client.findUnique({ where: { brokerId_email: { brokerId: broker.id, email: who.email } } });
  if (!found) return clearGoogleCookies(NextResponse.redirect(`${origin}/register?google=1&email=${encodeURIComponent(who.email)}`, 303));
  if (found.status !== "ACTIVE") return back("failed");
  // Google has proved this inbox belongs to them: the same proof as our confirmation link
  if (!found.emailVerifiedAt) {
    await prisma.client.update({ where: { id: found.id }, data: { emailVerifiedAt: new Date() } });
  }

  // 2FA on: no session yet; a short-lived ticket bound to this browser waits for the code (POST /api/auth/google/2fa)
  if (found.twoFactorEnabled && found.twoFactorSecret) {
    const ticket = randomToken();
    await getRedis().set(google2faKey(ticket), JSON.stringify({ clientId: found.id, brokerId: broker.id, remember: attempt.remember, tries: 0 }), "EX", GOOGLE_2FA_SECONDS);
    const res = clearGoogleCookies(NextResponse.redirect(`${origin}/login?google=2fa`, 303));
    res.cookies.set(GOOGLE_2FA_COOKIE, ticket, { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: GOOGLE_COOKIE_PATH, maxAge: GOOGLE_2FA_SECONDS });
    return res;
  }
  return googleSignIn(request, found, broker.id, attempt.remember, NextResponse.redirect(`${origin}/room`, 303));
}
