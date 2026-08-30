import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAccount,
  completeAccountLogin,
  getAccountSession,
  ACCOUNT_SESSION_COOKIE_NAME,
  accountSessionCookieOptions,
} from "@/lib/account-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { issuePending2faChallenge } from "@/lib/totp";

// Login is by accountNumber (MT-style numeric login), not email, since one
// trader can hold both a DEMO and a LIVE Account under the same email —
// accountNumber is the one globally-unique, unambiguous identifier.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const accountNumber = typeof body?.accountNumber === "string" ? body.accountNumber.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  // Optional -- only the login page's own Server selector (DEMO/LIVE)
  // sends this; the Account Selector's call site (WebTrader.tsx,
  // switching between linked accounts) omits it and skips this check
  // entirely, same as before this parameter existed.
  const expectedAccountType = body?.accountType === "LIVE" ? "LIVE" : body?.accountType === "DEMO" ? "DEMO" : null;
  // fix/realtime-sync §7 -- "Keep me signed in" checkbox (TradeLoginForm.tsx).
  // Defaults true so a caller that never sends it (the Account Selector's
  // own use of this same route, WebTrader.tsx switching linked accounts)
  // keeps today's always-persistent behavior.
  const remember = body?.remember !== false;

  // 5 attempts/minute per (broker, accountNumber) — throttles credential
  // stuffing against one account without needing to trust a client IP
  // header. Checked before the DB lookup so a locked-out account doesn't
  // even cost a bcrypt compare.
  const { allowed } = await checkRateLimit(`login:${brokerId}:${accountNumber}`, 5, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  // Read any existing session *before* authenticating the new one -- this is
  // how we tell a genuine fresh login apart from the Account Selector
  // (docs/webtrader-stm-architecture-review.md §4.2) using this same route
  // to switch a trader already signed into one linked account over to
  // another. Only the latter gets audited; a normal login from the login
  // page has no prior session to compare against.
  const previousSession = await getAccountSession();

  // Constant-shape response whether the account doesn't exist, belongs to a
  // different broker, is inactive, or the password is wrong — avoid leaking
  // any of it.
  const account = await authenticateAccount(brokerId, accountNumber, password);
  if (!account) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  // Checked only after a correct password -- the trader has already
  // proven they own this account, so telling them its real type here
  // isn't a meaningful information leak the way it would be pre-auth.
  if (expectedAccountType && account.accountType !== expectedAccountType) {
    const actual = account.accountType === "LIVE" ? "Live" : "Demo";
    return NextResponse.json(
      { error: `this is a ${actual} account -- select the ${actual} server and try again` },
      { status: 400 }
    );
  }

  // Password checked out, but that's only half of login for a 2FA-enabled
  // account -- no session yet, just a short-lived pending challenge the
  // client exchanges for one via POST /api/trade/login/verify-2fa once
  // the trader supplies their code. See lib/totp.ts's
  // issuePending2faChallenge doc comment for why the SSO handoff route
  // doesn't have this same branch.
  if (account.twoFactorEnabled) {
    const pendingToken = await issuePending2faChallenge({ accountId: account.id, brokerId: account.brokerId });
    return NextResponse.json({ requiresTwoFactor: true, pendingToken });
  }

  const userAgent = request.headers.get("user-agent");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const token = await completeAccountLogin(account, previousSession, { userAgent, ip }, remember);

  const response = NextResponse.json({
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountType: account.accountType,
  });
  response.cookies.set(ACCOUNT_SESSION_COOKIE_NAME, token, accountSessionCookieOptions(remember));
  return response;
}
