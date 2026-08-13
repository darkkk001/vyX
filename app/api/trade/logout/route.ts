import { NextRequest, NextResponse } from "next/server";
import { ACCOUNT_SESSION_COOKIE_NAME, revokeAccountSession } from "@/lib/account-auth";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(ACCOUNT_SESSION_COOKIE_NAME)?.value;
  // Deletes the Redis-held session record, not just the cookie — a token
  // captured before logout (e.g. via a leaked log line, an XSS bug
  // elsewhere) can no longer be replayed after this. Clearing only the
  // cookie, as before Redis-backed sessions, left the JWT itself valid
  // until its own expiry regardless of "logout".
  if (token) {
    await revokeAccountSession(token);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ACCOUNT_SESSION_COOKIE_NAME);
  return response;
}
