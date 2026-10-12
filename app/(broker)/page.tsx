import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import BrokerLandingPage from "./BrokerLandingPage";
import DemoEntry from "@/components/demo/DemoEntry";
import { getAccountSession } from "@/lib/account-auth";
import { isDemoTenant } from "@/lib/demo-policy";

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

  // QoreTrader demo: the root opens the terminal straight away. A visitor with a guest session goes to /trade; anyone else
  // gets a guest account made by the browser (never by a crawler: the page makes the request itself).
  if (isDemoTenant(headerList.get("x-broker-slug"))) {
    if (await getAccountSession()) redirect("/trade");
    return <DemoEntry brokerName={broker.name} logoUrl={broker.logoUrl ?? ""} />;
  }

  return (
    <BrokerLandingPage
      brokerName={broker.name}
      brokerLogoUrl={broker.logoUrl}
      supportEmail={broker.supportEmail}
    />
  );
}
