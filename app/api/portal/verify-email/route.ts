import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { consumeEmailVerificationToken } from "@/lib/client-auth";

// The other half of registration's own token mint (POST /api/portal/
// register) -- single-use (GETDEL under the hood), 24h TTL. Redirects to
// the portal login with a query flag either way rather than rendering
// JSON here, since this is always reached via a real browser navigation
// (a link in an email), never fetch().
export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.redirect(`${origin}/portal/login?verify=invalid`, { status: 303 });
  }

  const clientId = await consumeEmailVerificationToken(token);
  if (!clientId) {
    return NextResponse.redirect(`${origin}/portal/login?verify=invalid`, { status: 303 });
  }

  await prisma.client.update({ where: { id: clientId }, data: { emailVerifiedAt: new Date() } });

  return NextResponse.redirect(`${origin}/portal/login?verify=success`, { status: 303 });
}
