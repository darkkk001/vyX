import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import ManagerLoginForm from "./ManagerLoginForm";

// Resolved fresh per request (never baked into the build) so a broker's
// branding update takes effect immediately -- same principle as
// app/(broker)/layout.tsx. No session exists yet at this point (that's
// the whole point of a login page), so this reads x-broker-id directly
// rather than going through getManagerSession.
export default async function ManagerLoginPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true, supportEmail: true } })
    : null;

  return (
    <ManagerLoginForm
      brokerName={broker?.name ?? "Backoffice"}
      logoUrl={broker?.logoUrl ?? null}
      supportEmail={broker?.supportEmail ?? null}
    />
  );
}
