import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, getAdminSessionToken, revokeSessionToken, sessionCookieOptions } from "@/lib/auth";

// Real revocation now (Redis session store, see lib/auth.ts's own
// comment) -- this used to only clear the cookie client-side, leaving a
// captured token valid until its own 7/30-day expiry regardless of
// logout. Same fix app/api/trade/logout already has for trader sessions.
export async function POST() {
  const token = await getAdminSessionToken();
  if (token) {
    await revokeSessionToken(token);
  }

  const response = NextResponse.json({ ok: true });
  // Must match the domain the cookie was set with (sessionCookieOptions)
  // -- a delete without it is a no-op against a domain-scoped cookie, since
  // browsers key cookies by (name, domain, path), not name alone.
  const { domain, path } = sessionCookieOptions();
  response.cookies.delete({ name: SESSION_COOKIE_NAME, domain, path });
  return response;
}
