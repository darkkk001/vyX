import { NextRequest, NextResponse } from "next/server";
import { CLIENT_SESSION_COOKIE_NAME, revokeClientSession, clientSessionCookieOptions } from "@/lib/client-auth";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(CLIENT_SESSION_COOKIE_NAME)?.value;
  if (token) {
    await revokeClientSession(token);
  }

  const response = NextResponse.json({ ok: true });
  // Must match the domain the cookie was set with (clientSessionCookieOptions)
  // -- a delete without it is a no-op against a domain-scoped cookie, same
  // rule app/api/trade/logout's own comment already documents.
  const { domain, path } = await clientSessionCookieOptions();
  response.cookies.delete({ name: CLIENT_SESSION_COOKIE_NAME, domain, path });
  return response;
}
