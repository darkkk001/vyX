import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import BrokerLandingPage from "./BrokerLandingPage";

// Sole handler for "/". middleware.ts only attaches x-broker-* headers on
// broker subdomains/custom domains — the root domain and admin.<root>
// pass through untouched, so their absence here means "not a broker
// request" and we send it to the Super Admin login instead.
export default async function RootPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");

  if (!brokerId) {
    redirect("/login");
  }

  const broker = await prisma.broker.findUnique({
    where: { id: brokerId },
    select: { name: true, logoUrl: true, supportEmail: true },
  });

  if (!broker) {
    redirect("/broker-not-found");
  }

  return (
    <BrokerLandingPage
      brokerName={broker.name}
      brokerLogoUrl={broker.logoUrl}
      supportEmail={broker.supportEmail}
    />
  );
}
