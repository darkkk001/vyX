import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";
import { issueSsoToken } from "@/lib/sso";
import { requestOrigin } from "@/lib/request-origin";

// The Client Portal becoming a caller of the existing WebTrader SSO
// handoff (lib/sso.ts, app/(broker)/trade/sso/route.ts) -- the same
// mechanism app/api/trade/sso/token/route.ts exposes to a BROKER'S OWN
// EXTERNAL portal (authenticated there via X-Broker-Secret, since that
// caller is a separate system vouching for a trader it already
// authenticated itself). This route doesn't need that secret dance at
// all: it's already running inside this same trusted server, and the
// Client Portal has already authenticated the caller itself
// (getClientSession) -- it just needs to prove the requested account
// actually belongs to this client before minting a token for it.
//
// A real navigation (GET, not fetch+redirect) so a client clicking
// "Open WebTrader" ends up on /trade, fully logged in, in one browser
// hop through /trade/sso -- exactly how a broker's own external portal's
// redirect already works for that other caller.
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const session = await getClientSession();
  if (!session) {
    return NextResponse.redirect(`${origin}/portal/login`, { status: 303 });
  }

  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.redirect(`${origin}/portal/webtrader?error=missing_account`, { status: 303 });
  }

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.clientId !== session.clientId || account.brokerId !== session.brokerId || account.status !== "ACTIVE") {
    return NextResponse.redirect(`${origin}/portal/webtrader?error=invalid_account`, { status: 303 });
  }

  const token = await issueSsoToken({ accountId: account.id, brokerId: session.brokerId });
  return NextResponse.redirect(`${origin}/trade/sso?token=${token}`, { status: 303 });
}
