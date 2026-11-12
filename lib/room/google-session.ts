import { NextRequest, NextResponse } from "next/server";
import { createClientSession, CLIENT_SESSION_COOKIE_NAME, clientSessionCookieOptions } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import { clientIp } from "@/lib/order-execution";
import { GOOGLE_2FA_COOKIE, GOOGLE_COOKIE_PATH, GOOGLE_STATE_COOKIE } from "@/lib/room/google-login";

// The end of a Google sign-in: the same session, "Last login" step and cookie as the password sign-in
// (app/api/portal/login/route.ts).
export async function googleSignIn(
  request: NextRequest,
  client: { id: string; lastLoginAt: Date | null },
  brokerId: string,
  remember: boolean,
  res: NextResponse,
): Promise<NextResponse> {
  const token = await createClientSession({ clientId: client.id, brokerId }, remember, { userAgent: request.headers.get("user-agent"), ip: clientIp(request.headers) });
  await prisma.client
    .update({ where: { id: client.id }, data: { prevLoginAt: client.lastLoginAt, lastLoginAt: new Date() } })
    .catch((err) => console.error("[google-login] login time update failed", err));
  res.cookies.set(CLIENT_SESSION_COOKIE_NAME, token, await clientSessionCookieOptions(remember));
  return clearGoogleCookies(res);
}

export function clearGoogleCookies(res: NextResponse): NextResponse {
  for (const name of [GOOGLE_STATE_COOKIE, GOOGLE_2FA_COOKIE]) res.cookies.set(name, "", { httpOnly: true, path: GOOGLE_COOKIE_PATH, maxAge: 0 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
