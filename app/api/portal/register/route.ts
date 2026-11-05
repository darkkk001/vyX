import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { leadFromSignup } from "@/lib/crm/leads";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashPassword } from "@/lib/client-auth";
import { sendAccountExistsEmail, sendClientVerificationEmail } from "@/lib/email/verification-email";
import { requestOrigin } from "@/lib/request-origin";
import { RESEND_PER_EMAIL_PER_HOUR } from "@/lib/email/verification-email";
import { clientIpOf } from "@/lib/demo";
import { checkRegisterForm, REGISTER_PER_IP_PER_HOUR } from "@/lib/portal-register-guard";
import { clientIp } from "@/lib/order-execution";
import { humanCheckSiteKey, verifyHumanCheck } from "@/lib/turnstile";

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
  if ((await humanCheckSiteKey(brokerId)) && (await verifyHumanCheck(body?.turnstileToken, clientIp(request.headers))) === "bad") {
    return NextResponse.json({ error: "complete the check to continue", code: "HUMAN_CHECK_REQUIRED" }, { status: 400 });
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

  // The same answer for every address (owner 2026-11-05): new, unverified or already registered, the caller is told to
  // check the inbox, so this form cannot be used to find out who has an account. The inbox itself says what happened.
  const passwordHash = await hashPassword(password); // on every path, so the answer takes the same time
  const existing = await prisma.client.findUnique({ where: { brokerId_email: { brokerId, email } } });
  if (existing) {
    // Signing up again (owner 2026-11-03): the stored name and password are NOT changed. An address that never verified
    // gets a fresh link: whoever controls the inbox finishes with the original details, or resets the password after
    // verifying. A registered one gets a note with the way to sign in. Same per-address budget as the portal's own
    // resend, so this cannot be used to flood an inbox.
    const byEmail = await checkRateLimit(`portal-resend-verification:${brokerId}:${email}`, RESEND_PER_EMAIL_PER_HOUR, 60 * 60);
    if (byEmail.allowed && existing.status === "ACTIVE") {
      try {
        if (existing.emailVerifiedAt) {
          await sendAccountExistsEmail({ brokerId, email: existing.email, fallbackOrigin: () => requestOrigin(request) });
          return NextResponse.json({ email: existing.email });
        }
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

  // Partner portal (CRM 2026-11-03): a sign-up through a partner's link (?ref=CODE on /portal/register) remembers the
  // partner; their live accounts are attached to it later (lib/room/partner.ts). An unknown code is simply ignored.
  const ref = typeof body?.ref === "string" ? body.ref.trim().toUpperCase().slice(0, 16) : "";
  const referrer = ref ? await prisma.client.findFirst({ where: { brokerId, referralCode: ref }, select: { id: true } }) : null;

  const client = await prisma.client.create({
    data: { brokerId, email, passwordHash, fullName, source: referrer ? `IB · ${ref}` : "WEBSITE", ...(referrer ? { referredByClientId: referrer.id } : {}) },
  });
  // CRM module: every sign-up is a lead in the pipeline (lib/crm/leads.ts); brokers without it get none
  const crm = await prisma.broker.findUnique({ where: { id: brokerId }, select: { crmEnabled: true } });
  if (crm?.crmEnabled) await leadFromSignup({ brokerId, clientId: client.id, fullName, email, source: client.source ?? "WEBSITE" });

  // The verification e-mail lives in lib/email/verification-email.ts, shared with
  // app/api/portal/resend-verification so the two can never drift apart.
  const { usedMock, verifyUrl } = await sendClientVerificationEmail({
    brokerId,
    clientId: client.id,
    email,
    fallbackOrigin: () => requestOrigin(request),
  });

  return NextResponse.json({
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
