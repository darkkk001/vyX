import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import NextManagerLoginForm from "./NextManagerLoginForm";

// Resolved fresh per request (never baked into the build) so a broker's
// branding update takes effect immediately -- same principle as
// app/(broker)/layout.tsx. No session exists yet at this point (that's
// the whole point of a login page), so this reads x-broker-id directly
// rather than going through getManagerSession.
export default async function ManagerLoginPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  return <NextManagerLoginForm brokerName={broker?.name ?? "Backoffice"} logoUrl={broker?.logoUrl ?? null} />;
}
