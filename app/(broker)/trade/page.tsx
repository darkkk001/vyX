import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAccountSession } from "@/lib/account-auth";
import { prisma } from "@/lib/prisma";
import WebTrader from "@/components/webtrader/WebTrader";
import "./webtrader.css";

export default async function TradePage() {
  const session = await getAccountSession();
  if (!session) {
    redirect("/trade/login");
  }

  const headerList = await headers();
  const brokerSlug = headerList.get("x-broker-slug") || "vyX";
  const brokerLogoUrl = headerList.get("x-broker-logo-url") || "";
  // The real display name (e.g. "AcmeFX"), not the lowercase subdomain
  // middleware.ts forwards -- falls back to the slug if the broker
  // somehow isn't found (session already proved brokerId resolved, so
  // this is only a defensive fallback, not an expected path).
  const broker = await prisma.broker.findUnique({
    where: { id: session.brokerId },
    select: { name: true, supportEmail: true },
  });

  return (
    <WebTrader
      brokerName={broker?.name ?? brokerSlug}
      brokerLogoUrl={brokerLogoUrl}
      supportEmail={broker?.supportEmail ?? null}
    />
  );
}
