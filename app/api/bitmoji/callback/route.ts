import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { requestOrigin } from "@/lib/request-origin";
import {
  BITMOJI_CALLBACK_PATH, BITMOJI_COOKIE, bitmojiEnabledFor, fetchBitmojiAvatar, readAttemptCookie, sameString, snapClientId,
} from "@/lib/room/bitmoji";

// Snap sends the client back here (the redirect URI registered in the Snap Kit app). The state must match the attempt
// cookie, which must belong to the signed-in client; then the code is exchanged (PKCE) for a token, the avatar's image
// URL is read and saved on Client. Snap's tokens are dropped. Every outcome lands on Profile with a short result.
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const back = (result: string) => {
    const res = NextResponse.redirect(`${origin}/room/profile?bitmoji=${result}`, 303);
    res.cookies.set(BITMOJI_COOKIE, "", { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: "/api/bitmoji", maxAge: 0 });
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const ctx = await roomApiSession();
  if ("response" in ctx) return NextResponse.redirect(`${origin}/login`, 303);
  const { session } = ctx;
  const clientId = snapClientId();
  if (!clientId || !bitmojiEnabledFor(session.broker.subdomain)) return back("off");

  const q = request.nextUrl.searchParams;
  if (q.get("error")) return back("cancelled");
  const code = q.get("code");
  const state = q.get("state");
  const attempt = readAttemptCookie(request.cookies.get(BITMOJI_COOKIE)?.value);
  if (!code || !state || !attempt || attempt.clientId !== session.clientId || !sameString(attempt.state, state)) return back("expired");

  const kyc = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId }, select: { status: true } });
  if (kyc?.status !== "APPROVED") return back("verify");

  let avatar: string;
  try {
    avatar = await fetchBitmojiAvatar({ clientId, redirectUri: `${origin}${BITMOJI_CALLBACK_PATH}`, code, verifier: attempt.verifier });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "unknown";
    console.warn(`[bitmoji] connect failed for client ${session.clientId}: ${reason}`);
    return back(reason === "no-avatar" ? "no-avatar" : "failed");
  }
  await prisma.client.updateMany({
    where: { id: session.clientId, brokerId: session.brokerId },
    data: { bitmojiAvatarUrl: avatar, bitmojiConnectedAt: new Date() },
  });
  return back("connected");
}
