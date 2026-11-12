import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { requestOrigin } from "@/lib/request-origin";
import {
  BITMOJI_CALLBACK_PATH, BITMOJI_COOKIE, bitmojiEnabledFor, fetchBitmojiAvatar, readAttemptCookie, sameString, snapClientId,
} from "@/lib/room/bitmoji";

// Snap sends the client back here (the redirect URI registered in the Snap Kit app). The sign-in is the implicit grant
// Snap's web SDK uses, so the token arrives in the URL fragment, which never reaches a server: GET serves a small page
// that takes the fragment off the address bar and posts access_token + state back here. POST checks the state against
// the attempt cookie (which must belong to the signed-in client), reads the avatar with the token and saves its image
// URL on Client. Snap's token is dropped. Every outcome lands on Profile with a short result.

function backTo(origin: string, result: string) {
  const res = NextResponse.redirect(`${origin}/room/profile?bitmoji=${result}`, 303);
  res.cookies.set(BITMOJI_COOKIE, "", { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: "/api/bitmoji", maxAge: 0 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const HANDOFF = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>Connecting Bitmoji</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;background:#fff;color:#555}@media (prefers-color-scheme:dark){body{background:#111;color:#aaa}}</style>
</head><body>
<form method="post" action="${BITMOJI_CALLBACK_PATH}"><input type="hidden" name="access_token"><input type="hidden" name="state"><input type="hidden" name="error"></form>
<p>Connecting Bitmoji…</p>
<noscript><p><a href="/room/profile">Back to Profile</a></p></noscript>
<script>(function(){var h=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);var f=document.forms[0];f.access_token.value=h.get("access_token")||"";f.state.value=h.get("state")||"";f.error.value=h.get("error")||"";f.submit();})();</script>
</body></html>`;

export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const ctx = await roomApiSession();
  if ("response" in ctx) return NextResponse.redirect(`${origin}/login`, 303);
  if (!snapClientId() || !bitmojiEnabledFor(ctx.session.broker.subdomain)) return backTo(origin, "off");
  if (request.nextUrl.searchParams.get("error")) return backTo(origin, "cancelled");
  return new NextResponse(HANDOFF, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" },
  });
}

export async function POST(request: NextRequest) {
  const origin = requestOrigin(request);
  const ctx = await roomApiSession();
  if ("response" in ctx) return NextResponse.redirect(`${origin}/login`, 303);
  const { session } = ctx;
  if (!snapClientId() || !bitmojiEnabledFor(session.broker.subdomain)) return backTo(origin, "off");

  const form = await request.formData().catch(() => null);
  const field = (k: string) => { const v = form?.get(k); return typeof v === "string" ? v : ""; };
  if (field("error")) return backTo(origin, "cancelled");
  const token = field("access_token");
  const state = field("state");
  const attempt = readAttemptCookie(request.cookies.get(BITMOJI_COOKIE)?.value);
  if (!token || !state || !attempt || attempt.clientId !== session.clientId || !sameString(attempt.state, state)) return backTo(origin, "expired");

  const kyc = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId }, select: { status: true } });
  if (kyc?.status !== "APPROVED") return backTo(origin, "verify");

  let avatar: string;
  try {
    avatar = await fetchBitmojiAvatar(token);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "unknown";
    console.warn(`[bitmoji] connect failed for client ${session.clientId}: ${reason}`);
    return backTo(origin, reason === "no-avatar" ? "no-avatar" : "failed");
  }
  await prisma.client.updateMany({
    where: { id: session.clientId, brokerId: session.brokerId },
    data: { bitmojiAvatarUrl: avatar, bitmojiConnectedAt: new Date() },
  });
  return backTo(origin, "connected");
}
