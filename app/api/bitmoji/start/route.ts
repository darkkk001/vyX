import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { requestOrigin } from "@/lib/request-origin";
import {
  BITMOJI_CALLBACK_PATH, BITMOJI_COOKIE, BITMOJI_COOKIE_MAX_AGE, attemptCookie, bitmojiEnabledFor, newConnectAttempt, snapAuthUrl, snapClientId,
} from "@/lib/room/bitmoji";

// Profile's "Connect Bitmoji" (lib/room/bitmoji.ts): a verified client of a broker with the flag on is sent to Snap's
// sign-in (Login Kit, PKCE). The attempt's state and verifier ride in a short-lived httpOnly cookie, bound to this client.
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const back = (result: string) => NextResponse.redirect(`${origin}/room/profile?bitmoji=${result}`, 303);
  const ctx = await roomApiSession();
  if ("response" in ctx) return NextResponse.redirect(`${origin}/login`, 303);
  const { session } = ctx;
  const clientId = snapClientId();
  if (!clientId || !bitmojiEnabledFor(session.broker.subdomain)) return back("off");
  const kyc = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId }, select: { status: true } });
  if (kyc?.status !== "APPROVED") return back("verify");

  const { state, verifier, challenge } = newConnectAttempt();
  const res = NextResponse.redirect(snapAuthUrl(clientId, `${origin}${BITMOJI_CALLBACK_PATH}`, state, challenge), 303);
  res.cookies.set(BITMOJI_COOKIE, attemptCookie(session.clientId, state, verifier), {
    httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: "/api/bitmoji", maxAge: BITMOJI_COOKIE_MAX_AGE,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
