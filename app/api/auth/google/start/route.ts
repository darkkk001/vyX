import { NextRequest, NextResponse } from "next/server";
import { roomBroker } from "@/lib/room/context";
import { requestOrigin } from "@/lib/request-origin";
import { getRedis } from "@/lib/redis";
import { checkRateLimit } from "@/lib/rate-limit";
import { clientIpOf } from "@/lib/demo";
import {
  GOOGLE_ATTEMPT_SECONDS, GOOGLE_CALLBACK_PATH, GOOGLE_COOKIE_PATH, GOOGLE_STATE_COOKIE, googleAttemptKey, googleAuthUrl, googleClient,
  googleLoginEnabledFor, randomToken,
} from "@/lib/room/google-login";

// "Continue with Google" (lib/room/google-login.ts): sends the browser to Google's account chooser.
// ?remember=0 carries the sign-in's "Keep me signed in" box through the trip.
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const broker = await roomBroker();
  const client = googleClient();
  if (!broker || !client || !googleLoginEnabledFor(broker.subdomain)) return NextResponse.redirect(`${origin}/login`, 303);
  const ip = clientIpOf(request.headers);
  if (!(await checkRateLimit(`google-login-ip:${broker.id}:${ip}`, 30, 60)).allowed) return NextResponse.redirect(`${origin}/login?google=failed`, 303);

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const remember = request.nextUrl.searchParams.get("remember") !== "0";
  await getRedis().set(googleAttemptKey(state), JSON.stringify({ brokerId: broker.id, nonce, verifier, remember }), "EX", GOOGLE_ATTEMPT_SECONDS);

  const res = NextResponse.redirect(googleAuthUrl(client.id, `${origin}${GOOGLE_CALLBACK_PATH}`, state, nonce, verifier), 303);
  res.cookies.set(GOOGLE_STATE_COOKIE, state, { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: GOOGLE_COOKIE_PATH, maxAge: GOOGLE_ATTEMPT_SECONDS });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
