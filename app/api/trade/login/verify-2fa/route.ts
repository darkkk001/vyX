import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  completeAccountLogin,
  getAccountSession,
  ACCOUNT_SESSION_COOKIE_NAME,
  accountSessionCookieOptions,
} from "@/lib/account-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { peekPending2faChallenge, deletePending2faChallenge, verifyTotp } from "@/lib/totp";

// The second step for a 2FA-enabled account, once app/api/trade/login's
// password check returned { requiresTwoFactor: true, pendingToken }.
// Shares completeAccountLogin with that route's own non-2FA branch so
// session creation / the account-switch audit can't drift between the
// two entry points.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const pendingToken = typeof body?.pendingToken === "string" ? body.pendingToken : "";
  const code = typeof body?.code === "string" ? body.code : "";
  if (!pendingToken || !code) {
    return NextResponse.json({ error: "pendingToken and code are required" }, { status: 400 });
  }

  // Throttles guessing the 6-digit code within the challenge's 5-minute
  // TTL -- keyed by the pending token itself (unique per login attempt),
  // not the account, since the challenge doesn't survive past its own TTL
  // either way.
  const { allowed } = await checkRateLimit(`verify-2fa:${pendingToken}`, 10, 300);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const pending = await peekPending2faChallenge(pendingToken);
  if (!pending) {
    return NextResponse.json({ error: "login expired, please sign in again" }, { status: 401 });
  }

  // Read any existing session before this one lands -- same Account
  // Selector switch-detection app/api/trade/login's own non-2FA branch
  // does, just deferred here until the 2FA-gated login actually
  // completes.
  const previousSession = await getAccountSession();

  const account = await prisma.account.findUnique({ where: { id: pending.accountId } });
  if (!account || account.status !== "ACTIVE" || !account.twoFactorEnabled || !account.twoFactorSecret) {
    await deletePending2faChallenge(pendingToken);
    return NextResponse.json({ error: "login expired, please sign in again" }, { status: 401 });
  }

  if (!verifyTotp(account.twoFactorSecret, code)) {
    return NextResponse.json({ error: "invalid code" }, { status: 401 });
  }

  await deletePending2faChallenge(pendingToken);

  const userAgent = request.headers.get("user-agent");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const token = await completeAccountLogin(account, previousSession, { userAgent, ip });

  const response = NextResponse.json({
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountType: account.accountType,
  });
  response.cookies.set(ACCOUNT_SESSION_COOKIE_NAME, token, accountSessionCookieOptions());
  return response;
}
