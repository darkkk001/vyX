import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashPassword } from "@/lib/client-auth";
import { sendClientVerificationEmail } from "@/lib/email/verification-email";
import { requestOrigin } from "@/lib/request-origin";

// Client Portal self-registration (Stage 1) -- email + password, not an
// account number (that's Account's own, separate credential -- see
// lib/client-auth.ts's own module comment). Creates a Client row with
// emailVerifiedAt null; login is refused until the verification link
// (below) is clicked. No trading account is created here at all --
// that's Stage 3's Trading Accounts flow, once this Client can log in.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`portal-register:${brokerId}`, 10, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim() : "";

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }
  if (!fullName) {
    return NextResponse.json({ error: "full name is required" }, { status: 400 });
  }

  const existing = await prisma.client.findUnique({ where: { brokerId_email: { brokerId, email } } });
  if (existing) {
    // Same email enumerated back either way -- constant response shape --
    // but the real reason is worth telling a genuine owner of that inbox:
    // "log in" or "verify" are both actionable, "try a different email"
    // isn't, and neither leaks anything an attacker couldn't already
    // learn by attempting to log in with a guessed email regardless.
    return NextResponse.json(
      { error: existing.emailVerifiedAt ? "an account with this email already exists, try logging in" : "an account with this email already exists, check your inbox for the verification link" },
      { status: 409 }
    );
  }

  const passwordHash = await hashPassword(password);
  const client = await prisma.client.create({
    data: { brokerId, email, passwordHash, fullName },
  });

  // The verification e-mail lives in lib/email/verification-email.ts, shared with
  // app/api/portal/resend-verification so the two can never drift apart.
  const { usedMock, verifyUrl } = await sendClientVerificationEmail({
    brokerId,
    clientId: client.id,
    email,
    fallbackOrigin: () => requestOrigin(request),
  });

  return NextResponse.json({
    clientId: client.id,
    email: client.email,
    // Mock-adapter-only convenience (see lib/email/adapter.ts's own
    // comment) -- outside production, hands the verify link straight
    // back so this whole flow is testable without a real inbox. Only
    // present when this broker's send actually went through Mock (not
    // configured for Resend, or Resend unset platform-wide), and never
    // present in production regardless of provider.
    ...(process.env.NODE_ENV !== "production" && usedMock ? { devVerifyUrl: verifyUrl } : {}),
  });
}
