import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { requestOrigin } from "@/lib/request-origin";
import {
  BITMOJI_CALLBACK_PATH, BITMOJI_COOKIE, BITMOJI_COOKIE_MAX_AGE, attemptCookie, bitmojiEnabledFor, newConnectState, snapAuthUrl, snapClientId,
} from "@/lib/room/bitmoji";
import { bitmojiResult } from "@/lib/room/bitmoji-result";

// Profile's "Connect Bitmoji" (lib/room/bitmoji.ts): a verified client of a broker with the flag on is sent to Snap's
// sign-in (Login Kit web, the URL Snap's SDK builds). The attempt's state rides in a short-lived httpOnly cookie, bound
// to this client. ?tab=1: Profile opened this in a new tab, so the result goes back to Profile and the tab closes.
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const tab = request.nextUrl.searchParams.get("tab") === "1";
  const ctx = await roomApiSession();
  if ("response" in ctx) return NextResponse.redirect(`${origin}/login`, 303);
  const { session } = ctx;
  const clientId = snapClientId();
  if (!clientId || !bitmojiEnabledFor(session.broker.subdomain)) return bitmojiResult(origin, "off", tab);
  const kyc = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId }, select: { status: true } });
  if (kyc?.status !== "APPROVED") return bitmojiResult(origin, "verify", tab);

  const state = newConnectState();
  const res = NextResponse.redirect(snapAuthUrl(clientId, `${origin}${BITMOJI_CALLBACK_PATH}`, state), 303);
  res.cookies.set(BITMOJI_COOKIE, attemptCookie(session.clientId, state, tab), {
    httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: "/api/bitmoji", maxAge: BITMOJI_COOKIE_MAX_AGE,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
