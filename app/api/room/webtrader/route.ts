import { NextRequest, NextResponse } from "next/server";
import { roomApiSession } from "@/lib/room/context";
import { requestOrigin } from "@/lib/request-origin";
import { issueSsoToken } from "@/lib/sso";
import { webTraderAccount } from "@/lib/room/webtrader";

// "Open WebTrader" from the Room (sidebar, Downloads, Dashboard's Trade on card; owner 2026-11-13): the signed-in
// client's live account opens in WebTrader already signed in, through the same one-time SSO token the portal's
// WebTrader link uses (/trade/sso). The account: the client's oldest active live account (not archived, not the
// funding wallet). No live account = WebTrader's own sign-in page. Signed out of the Room = the Room's sign-in.
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const ctx = await roomApiSession();
  if ("response" in ctx) return NextResponse.redirect(`${origin}/login`, 303);
  const { session } = ctx;
  const account = await webTraderAccount(session.clientId, session.brokerId);
  if (!account) return NextResponse.redirect(`${origin}/trade/login`, 303);
  const token = await issueSsoToken({ accountId: account.id, brokerId: session.brokerId });
  const res = NextResponse.redirect(`${origin}/trade/sso?token=${token}`, 303);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
