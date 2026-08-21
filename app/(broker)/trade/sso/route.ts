import { NextRequest, NextResponse } from "next/server";
import { consumeSsoToken } from "@/lib/sso";
import { createAccountSession, ACCOUNT_SESSION_COOKIE_NAME, accountSessionCookieOptions } from "@/lib/account-auth";

// The other half of the WebTrader SSO handoff (see
// app/api/trade/sso/token/route.ts): a broker's own portal redirects the
// trader's browser here with a one-time token from that route. Consuming
// it (single-use, ~30s TTL, see lib/sso.ts) proves this request really
// followed that redirect -- from there it's the exact same session this
// codebase already creates on a normal password login
// (app/api/trade/login/route.ts), just skipping the credential check
// because the broker already vouches for the trader.
export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.redirect(`${origin}/trade/login?error=sso`, { status: 303 });
  }

  const payload = await consumeSsoToken(token);
  if (!payload) {
    return NextResponse.redirect(`${origin}/trade/login?error=sso`, { status: 303 });
  }

  // The token was minted for one specific broker (lib/sso.ts's
  // SsoTokenPayload) -- cross-check it against the broker middleware.ts
  // resolved for the domain this request actually landed on, same rule
  // getAccountSession() applies to every subsequent request. A token
  // issued for Broker A used against Broker B's subdomain (shouldn't be
  // reachable in practice since it's redirected from Broker A's own
  // portal, but never assume that holds) is rejected here rather than
  // silently trusted.
  const requestBrokerId = request.headers.get("x-broker-id");
  if (!requestBrokerId || requestBrokerId !== payload.brokerId) {
    return NextResponse.redirect(`${origin}/trade/login?error=sso`, { status: 303 });
  }

  const sessionToken = await createAccountSession({ accountId: payload.accountId, brokerId: payload.brokerId });
  const response = NextResponse.redirect(`${origin}/trade`, { status: 303 });
  response.cookies.set(ACCOUNT_SESSION_COOKIE_NAME, sessionToken, accountSessionCookieOptions());
  return response;
}
