import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAccount,
  createAccountSession,
  ACCOUNT_SESSION_COOKIE_NAME,
  accountSessionCookieOptions,
} from "@/lib/account-auth";
import { checkRateLimit } from "@/lib/rate-limit";

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

  // 5 attempts/minute per (broker, accountNumber) — throttles credential
  // stuffing against one account without needing to trust a client IP
  // header. Checked before the DB lookup so a locked-out account doesn't
  // even cost a bcrypt compare.
  const { allowed } = await checkRateLimit(`login:${brokerId}:${accountNumber}`, 5, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  // Constant-shape response whether the account doesn't exist, belongs to a
  // different broker, is inactive, or the password is wrong — avoid leaking
  // any of it.
  const account = await authenticateAccount(brokerId, accountNumber, password);
  if (!account) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const token = await createAccountSession({
    accountId: account.id,
    brokerId: account.brokerId,
  });

  const response = NextResponse.json({
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountType: account.accountType,
  });
  response.cookies.set(ACCOUNT_SESSION_COOKIE_NAME, token, accountSessionCookieOptions());
  return response;
}
