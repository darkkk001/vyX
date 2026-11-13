import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { consumeEmailVerificationToken } from "@/lib/client-auth";
import { requestOrigin } from "@/lib/request-origin";

// The other half of registration's own token mint (POST /api/portal/
// register) -- single-use (GETDEL under the hood), 24h TTL. Redirects to
// the portal login with a query flag either way rather than rendering
// JSON here, since this is always reached via a real browser navigation
// (a link in an email), never fetch().
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  // one path for every broker: /login shows the Trader's Room sign-in when the CRM module is on
  const login = "/login";
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.redirect(`${origin}${login}?verify=invalid`, { status: 303 });
  }

  const clientId = await consumeEmailVerificationToken(token);
  if (!clientId) {
    return NextResponse.redirect(`${origin}${login}?verify=invalid`, { status: 303 });
  }

  // the link only works on the broker that sent it (owner 2026-11-13)
  const brokerId = request.headers.get("x-broker-id");
  const done = brokerId ? await prisma.client.updateMany({ where: { id: clientId, brokerId }, data: { emailVerifiedAt: new Date() } }) : { count: 0 };
  if (done.count === 0) {
    return NextResponse.redirect(`${origin}${login}?verify=invalid`, { status: 303 });
  }

  return NextResponse.redirect(`${origin}${login}?verify=success`, { status: 303 });
}
