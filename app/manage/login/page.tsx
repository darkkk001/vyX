import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import NextManagerLoginForm from "./NextManagerLoginForm";

// Resolved fresh per request (never baked into the build) so a broker's
// branding update takes effect immediately -- same principle as
// app/(broker)/layout.tsx. No session exists yet at this point (that's
// the whole point of a login page), so this reads x-broker-id directly
// rather than going through getManagerSession.
export default async function ManagerLoginPage({
  searchParams,
}: {
  // VYX-BASICS-AUDIT.md category 4 "session-expiry -> clean redirect
  // with a message" -- app/manage/(shell)/layout.tsx now appends
  // ?reason=expired when it redirects here over a missing/invalid
  // session, so this can actually SAY why the trader landed back on a
  // blank sign-in form instead of leaving that silent.
  searchParams: Promise<{ reason?: string }>;
}) {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;
  const { reason } = await searchParams;

  // Falls back to the platform's own name, not "Backoffice" -- this
  // form always appends " Backoffice" itself (see ManagerLoginForm.tsx),
  // so that fallback rendered as the literal "Backoffice Backoffice"
  // whenever no broker resolved (root domain, unknown subdomain).
  // Matches manager-shell/App.tsx's own branding-fetch-failure fallback.
  return (
    <NextManagerLoginForm
      brokerName={broker?.name ?? "VyXTrader"}
      logoUrl={broker?.logoUrl ?? null}
      sessionExpired={reason === "expired"}
    />
  );
}
