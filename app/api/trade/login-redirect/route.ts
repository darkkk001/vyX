import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAccount,
  createAccountSession,
  ACCOUNT_SESSION_COOKIE_NAME,
  accountSessionCookieOptions,
} from "@/lib/account-auth";
import { checkRateLimit } from "@/lib/rate-limit";

// Landing point for the root-domain launcher's (app/launch) single-screen
// login — a real cross-site <form method="POST"> submit (a top-level
// navigation, not a fetch), which browsers allow across origins unlike XHR,
// so the trader's password never has to travel through a URL or a
// same-site-only cookie. This request lands directly on the broker's own
// subdomain, so middleware.ts has already resolved x-broker-id normally —
// the session cookie this sets is correctly scoped here, not to the
// launcher's root domain.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  const origin = new URL(request.url).origin;
  if (!brokerId) {
    return NextResponse.redirect(`${origin}/trade/login?error=1`, { status: 303 });
  }

  const form = await request.formData().catch(() => null);
  const accountNumber = String(form?.get("accountNumber") ?? "").trim();
  const password = String(form?.get("password") ?? "");
  // Only present in the submitted form data when the checkbox was checked
  // (standard HTML behavior) — passed through so the desktop app knows
  // whether to remember this broker for next launch.
  const remember = form?.get("remember") ? "1" : "0";

  const { allowed } = await checkRateLimit(`login:${brokerId}:${accountNumber}`, 5, 60);
  if (!allowed) {
    const qs = accountNumber ? `?error=1&account=${encodeURIComponent(accountNumber)}` : "?error=1";
    return NextResponse.redirect(`${origin}/trade/login${qs}`, { status: 303 });
  }

  const account = await authenticateAccount(brokerId, accountNumber, password);
  if (!account) {
    const qs = accountNumber ? `?error=1&account=${encodeURIComponent(accountNumber)}` : "?error=1";
    return NextResponse.redirect(`${origin}/trade/login${qs}`, { status: 303 });
  }

  const token = await createAccountSession({
    accountId: account.id,
    brokerId: account.brokerId,
  });

  const response = NextResponse.redirect(`${origin}/trade?remember=${remember}`, { status: 303 });
  response.cookies.set(ACCOUNT_SESSION_COOKIE_NAME, token, accountSessionCookieOptions());
  return response;
}
