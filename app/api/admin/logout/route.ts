import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, sessionCookieOptions, getCurrentAdminSessionToken, revokeAdminSession } from "@/lib/auth";

// Phase 1 trust pack §2 -- this used to only clear the cookie, leaving
// the session itself (now Redis-backed, previously a self-verifying JWT)
// valid and replayable from a copied token until its own TTL expired.
// Revoking it here means a logout is real everywhere that checks this
// session, not just in the browser that clicked it -- including
// services/api-gateway's admin event stream, which re-validates every
// open connection against this same Redis key every 5s.
export async function POST() {
  const token = await getCurrentAdminSessionToken();
  if (token) {
    await revokeAdminSession(token);
  }

  const response = NextResponse.json({ ok: true });
  // Must match the domain the cookie was set with (sessionCookieOptions)
  // -- a delete without it is a no-op against a domain-scoped cookie, since
  // browsers key cookies by (name, domain, path), not name alone.
  const { domain, path } = sessionCookieOptions();
  response.cookies.delete({ name: SESSION_COOKIE_NAME, domain, path });
  return response;
}
