import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashPassword, issueEmailVerificationToken } from "@/lib/client-auth";
import { getEmailAdapter } from "@/lib/email/adapter";

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
      { error: existing.emailVerifiedAt ? "an account with this email already exists -- try logging in" : "an account with this email already exists -- check your inbox for the verification link" },
      { status: 409 }
    );
  }

  const passwordHash = await hashPassword(password);
  const client = await prisma.client.create({
    data: { brokerId, email, passwordHash, fullName },
  });

  const token = await issueEmailVerificationToken(client.id);
  const origin = new URL(request.url).origin;
  // Points straight at the API route, not a /portal/... page -- clicking
  // it needs no user input (unlike a password reset), so there's nothing
  // a page would add except an extra hop. GET /api/portal/verify-email
  // itself redirects to /portal/login?verify=... once Stage 2 builds that
  // page; today (Stage 1, no pages yet) that last hop 404s, which is
  // expected -- the verification itself still completes correctly before
  // that redirect fires, and this link needs no changes once Stage 2 lands.
  const verifyUrl = `${origin}/api/portal/verify-email?token=${token}`;

  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true } });
  const brokerName = broker?.name ?? "your broker";

  await getEmailAdapter().send({
    to: email,
    subject: `Verify your email for ${brokerName}`,
    html: `<p>Welcome to ${brokerName}. Click the link below to verify your email and finish setting up your account.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    text: `Welcome to ${brokerName}. Verify your email: ${verifyUrl}`,
  });

  return NextResponse.json({
    clientId: client.id,
    email: client.email,
    // Mock-adapter-only convenience (see lib/email/adapter.ts's own
    // comment) -- outside production, hands the verify link straight
    // back so this whole flow is testable without a real inbox. Never
    // present once EMAIL_PROVIDER=resend is actually configured, and
    // never present in production regardless of provider.
    ...(process.env.NODE_ENV !== "production" ? { devVerifyUrl: verifyUrl } : {}),
  });
}
