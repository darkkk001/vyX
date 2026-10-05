import { prisma } from "@/lib/prisma";
import { issueEmailVerificationToken } from "@/lib/client-auth";
import { sendBrokerEmail } from "@/lib/email/adapter";
import { renderBrokerEmail } from "@/lib/email/template";
import { brokerPublicOrigin } from "@/lib/request-origin";

// The Client Portal's "verify your email" e-mail, in ONE place: sent on
// registration (app/api/portal/register) and again on request
// (app/api/portal/resend-verification, owner 2026-10-05 after the 12-day
// e-mail outage left two sign-ups with no way to get a link). Both routes
// call sendClientVerificationEmail, so the two can never drift apart.

// app/api/portal/resend-verification limits (route files may only export handlers).
export const RESEND_PER_EMAIL_PER_HOUR = 3;
export const RESEND_PER_IP_PER_HOUR = 10;

export type VerificationBroker = {
  name: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
};

// Pure: what the e-mail says for a given broker and link (also what the
// tests compare, so register and resend are provably identical).
export function renderVerificationEmail(broker: VerificationBroker | null, verifyUrl: string) {
  const brokerName = broker?.name ?? "your broker";
  const { html, text } = renderBrokerEmail(
    { name: brokerName, logoUrl: broker?.logoUrl ?? null, primaryColor: broker?.primaryColor ?? null, supportEmail: broker?.supportEmail ?? null },
    {
      preheader: `Verify your email to finish setting up your ${brokerName} account.`,
      heading: `Welcome to ${brokerName}`,
      bodyLines: [
        `Thanks for creating an account with ${brokerName}. Confirm your email address to activate your account and get started.`,
      ],
      cta: { label: "Verify Email", url: verifyUrl },
      extraNote: "This link expires in 24 hours.",
    }
  );
  return { subject: `Verify your email for ${brokerName}`, html, text };
}

// Issues a fresh single-use token (24 h, Redis) and sends the e-mail.
// `fallbackOrigin` is only used when the broker row is missing (the
// register route passes the request's own origin, as it always did).
export async function sendClientVerificationEmail(args: {
  brokerId: string;
  clientId: string;
  email: string;
  fallbackOrigin: () => string;
}): Promise<{ usedMock: boolean; verifyUrl: string }> {
  const token = await issueEmailVerificationToken(args.clientId);

  const broker = await prisma.broker.findUnique({
    where: { id: args.brokerId },
    select: {
      name: true, subdomain: true, customDomain: true, logoUrl: true, primaryColor: true, supportEmail: true,
      emailEnabled: true, emailFromAddress: true, emailFromName: true,
    },
  });
  const brokerName = broker?.name ?? "your broker";

  // A mailed link has to be the broker's own real public domain, not
  // whatever origin this particular API request happened to arrive on
  // (see brokerPublicOrigin's own comment). Points straight at the API
  // route: clicking it needs no user input, and GET
  // /api/portal/verify-email redirects to /portal/login?verify=... itself.
  const origin = broker ? brokerPublicOrigin(broker) : args.fallbackOrigin();
  const verifyUrl = `${origin}/api/portal/verify-email?token=${token}`;

  const { subject, html, text } = renderVerificationEmail(broker, verifyUrl);

  const { usedMock } = await sendBrokerEmail(
    { name: brokerName, emailEnabled: broker?.emailEnabled ?? false, emailFromAddress: broker?.emailFromAddress ?? null, emailFromName: broker?.emailFromName ?? null },
    { to: args.email, subject, html, text }
  );
  return { usedMock, verifyUrl };
}

// app/api/manage/clients/[id]/resend-verification (staff action, owner 2026-10-05).
export const STAFF_RESEND_PER_CLIENT_PER_HOUR = 5;

// "z***@gmail.com": what a response may echo back without repeating the full address.
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
