import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  // Must match the domain the cookie was set with (sessionCookieOptions)
  // -- a delete without it is a no-op against a domain-scoped cookie, since
  // browsers key cookies by (name, domain, path), not name alone.
  const { domain, path } = sessionCookieOptions();
  response.cookies.delete({ name: SESSION_COOKIE_NAME, domain, path });
  return response;
}
