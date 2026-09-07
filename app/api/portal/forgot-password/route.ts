import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { issuePasswordResetToken } from "@/lib/client-auth";
import { sendBrokerEmail } from "@/lib/email/adapter";
import { renderBrokerEmail } from "@/lib/email/template";
import { brokerPublicOrigin, requestOrigin } from "@/lib/request-origin";

// Real, email-based reset -- unlike app/api/trade/forgot-password (the
// account-number one), which only creates a Notification for a dealer to
// manually reset since there's no email loop on that side. The Client
// Portal has one now (lib/email/adapter.ts), so this can be self-service.
// Always returns the same success shape whether or not the email exists
// -- constant-shape response, doesn't let a caller enumerate registered
// emails.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`portal-forgot-password:${brokerId}:${email}`, 3, 60 * 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429 });
  }

  const client = await prisma.client.findUnique({ where: { brokerId_email: { brokerId, email } } });
  let devResetUrl: string | undefined;
  let usedMock = false;

  if (client && client.status === "ACTIVE") {
    const token = await issuePasswordResetToken(client.id);

    const broker = await prisma.broker.findUnique({
      where: { id: brokerId },
      select: {
        name: true, subdomain: true, customDomain: true, logoUrl: true, primaryColor: true, supportEmail: true,
        emailEnabled: true, emailFromAddress: true, emailFromName: true,
      },
    });
    const brokerName = broker?.name ?? "your broker";

    // See brokerPublicOrigin's own comment (lib/request-origin.ts) --
    // same reasoning as register/route.ts's verify link: a mailed link
    // has to be the broker's real public domain, not this request's own.
    const origin = broker ? brokerPublicOrigin(broker) : requestOrigin(request);
    const resetUrl = `${origin}/portal/reset-password?token=${token}`;
    devResetUrl = resetUrl;

    const { html, text } = renderBrokerEmail(
      { name: brokerName, logoUrl: broker?.logoUrl ?? null, primaryColor: broker?.primaryColor ?? null, supportEmail: broker?.supportEmail ?? null },
      {
        preheader: `Reset your ${brokerName} account password.`,
        heading: "Reset your password",
        bodyLines: [`We received a request to reset the password on your ${brokerName} account. Click below to choose a new one.`],
        cta: { label: "Reset Password", url: resetUrl },
        extraNote: "This link expires in 1 hour.",
      }
    );

    ({ usedMock } = await sendBrokerEmail(
      { name: brokerName, emailEnabled: broker?.emailEnabled ?? false, emailFromAddress: broker?.emailFromAddress ?? null, emailFromName: broker?.emailFromName ?? null },
      {
        to: email,
        subject: `Reset your password for ${brokerName}`,
        html,
        text,
      }
    ));
  }

  return NextResponse.json({
    ok: true,
    message: "if an account exists for that email, a reset link has been sent",
    ...(process.env.NODE_ENV !== "production" && usedMock && devResetUrl ? { devResetUrl } : {}),
  });
}
