import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashPassword } from "@/lib/client-auth";
import { sendClientVerificationEmail } from "@/lib/email/verification-email";
import { requestOrigin } from "@/lib/request-origin";
import { RESEND_PER_EMAIL_PER_HOUR } from "@/lib/email/verification-email";
import { clientIpOf } from "@/lib/demo";
import { checkRegisterForm, REGISTER_PER_IP_PER_HOUR } from "@/lib/portal-register-guard";

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

  // per-IP limit (owner 2026-11-03, lib/portal-register-guard.ts): Vercel's own address headers, never x-forwarded-for
  const byIp = await checkRateLimit(`portal-register-ip:${clientIpOf(request.headers)}`, REGISTER_PER_IP_PER_HOUR, 60 * 60);
  if (!byIp.allowed) {
    return NextResponse.json({ error: "too many sign-ups from this network, try again later" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const form = await checkRegisterForm(body);
  if (!form.ok && form.kind === "honeypot") {
    // a bot filled the hidden field: answer like a success, create and send nothing
    console.warn("[portal-register] honeypot hit, dropped", { brokerId });
    return NextResponse.json({ email: typeof body?.email === "string" ? body.email.trim().toLowerCase() : "" });
  }
  if (!form.ok) {
    return NextResponse.json(
      form.kind === "too_fast"
        ? { error: "that was very fast, check your details and press Create account again", code: "TOO_FAST" }
        : { error: "this page has expired, reload it and try again", code: "FORM_EXPIRED" },
      { status: 400 }
    );
  }
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
  if (existing?.emailVerifiedAt) {
    return NextResponse.json({ error: "an account with this email already exists, try logging in" }, { status: 409 });
  }
  if (existing) {
    // Signing up again with an address that never verified (owner 2026-11-03): send a fresh link instead of a 409,
    // and answer exactly like a new sign-up ("check your email"). The stored name and password are NOT changed:
    // whoever controls the inbox finishes with the original details, or resets the password after verifying.
    // Same per-address budget as the portal's own resend, so this cannot be used to flood an inbox.
    const byEmail = await checkRateLimit(`portal-resend-verification:${brokerId}:${email}`, RESEND_PER_EMAIL_PER_HOUR, 60 * 60);
    if (byEmail.allowed && existing.status === "ACTIVE") {
      try {
        await sendClientVerificationEmail({ brokerId, clientId: existing.id, email: existing.email, fallbackOrigin: () => requestOrigin(request) });
        await prisma.auditLog.create({
          data: { brokerId, actorAdminId: null, action: "CLIENT_VERIFICATION_RESENT", entityType: "Client", entityId: existing.id, newValue: { email: existing.email, via: "register" } },
        });
      } catch (err) {
        console.error("[portal-register] verification resend failed", err);
      }
    }
    return NextResponse.json({ email: existing.email });
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
