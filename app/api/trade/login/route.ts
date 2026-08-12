import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAccount,
  createAccountSessionToken,
  ACCOUNT_SESSION_COOKIE_NAME,
  accountSessionCookieOptions,
} from "@/lib/account-auth";

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

  // Constant-shape response whether the account doesn't exist, belongs to a
  // different broker, is inactive, or the password is wrong — avoid leaking
  // any of it.
  const account = await authenticateAccount(brokerId, accountNumber, password);
  if (!account) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const token = await createAccountSessionToken({
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
