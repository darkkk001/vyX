import { NextResponse } from "next/server";
import { getAccountSession, issueWsTicket } from "@/lib/account-auth";

// Mints a short-lived, single-use ticket for the Gateway's price-tick /
// trading-event WebSockets (services/api-gateway/src/ws.ts) to authenticate
// a browser WS handshake by, instead of the httpOnly session cookie those
// streams normally read -- see issueWsTicket's own comment for why a
// broker's own custom domain needs this at all (a cookie set here can
// never reach feed.<ROOT_DOMAIN>, an unrelated domain). Same-origin POST
// on whatever domain the page is actually on, so the existing cookie auth
// works completely normally here regardless of subdomain vs custom domain
// -- only the WS leg needs the ticket detour.
export async function POST() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const ticket = await issueWsTicket(session.accountId, session.brokerId);
  return NextResponse.json({ ticket }, { headers: { "Cache-Control": "no-store" } });
}
