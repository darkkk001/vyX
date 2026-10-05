import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { RESEND_PER_EMAIL_PER_HOUR, RESEND_PER_IP_PER_HOUR, sendClientVerificationEmail } from "@/lib/email/verification-email";
import { requestOrigin } from "@/lib/request-origin";

// "Resend verification e-mail" for the Client Portal (owner 2026-10-05).
// Before this, a client whose verification e-mail never arrived (the 12-day
// e-mail outage after the Vercel move) could not log in (unverified) and
// could not register again (409), with no way out.
//
// Public and unauthenticated, like register and forgot-password. Constant
// response: a well-formed request always gets 200 {ok:true}, whether or not
// the address exists, is verified, or the send worked, so it cannot be used
// to find out which addresses are registered. It only ever mails the
// address's own inbox, and only for an ACTIVE, unverified client of THIS
// broker. Rate-limited per address and per IP.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const byIp = await checkRateLimit(`portal-resend-verification-ip:${brokerId}:${ip}`, RESEND_PER_IP_PER_HOUR, 60 * 60);
  if (!byIp.allowed) {
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429 });
  }
  const byEmail = await checkRateLimit(`portal-resend-verification:${brokerId}:${email}`, RESEND_PER_EMAIL_PER_HOUR, 60 * 60);
  if (!byEmail.allowed) {
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429 });
  }

  const client = await prisma.client.findUnique({ where: { brokerId_email: { brokerId, email } } });
  if (client && client.status === "ACTIVE" && !client.emailVerifiedAt) {
    try {
      await sendClientVerificationEmail({ brokerId, clientId: client.id, email: client.email, fallbackOrigin: () => requestOrigin(request) });
      await prisma.auditLog.create({
        data: { brokerId, actorAdminId: null, action: "CLIENT_VERIFICATION_RESENT", entityType: "Client", entityId: client.id, newValue: { email: client.email, via: "portal" } },
      });
    } catch (err) {
      console.error("[resend-verification] email send failed", err);
    }
  }

  return NextResponse.json({ ok: true });
}
