import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAccountSession } from "@/lib/account-auth";
import { prisma } from "@/lib/prisma";
import WebTrader from "@/components/webtrader/WebTrader";
import DemoEntry from "@/components/demo/DemoEntry";
import DemoTradeShell from "@/components/demo/DemoTradeShell";
import { isDemoTenant } from "@/lib/demo-policy";
import "./webtrader.css";

export default async function TradePage() {
  const session = await getAccountSession();
  const headerList = await headers();
  // QoreTrader demo: no sign-in screen. Without a session the visitor gets a guest account (components/demo/DemoEntry.tsx).
  const demo = isDemoTenant(headerList.get("x-broker-slug"));
  if (!session) {
    if (demo) {
      const entryBroker = await prisma.broker.findUnique({ where: { id: headerList.get("x-broker-id") ?? "" }, select: { name: true } });
      return <DemoEntry brokerName={entryBroker?.name ?? "QoreTrader Demo"} logoUrl={headerList.get("x-broker-logo-url") || ""} />;
    }
    redirect("/trade/login");
  }

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

  if (demo) {
    return <DemoTradeShell brokerName={broker?.name ?? brokerSlug} brokerLogoUrl={brokerLogoUrl} supportEmail={broker?.supportEmail ?? null} serverNowMs={Date.now()} />;
  }

  return (
    <WebTrader
      brokerName={broker?.name ?? brokerSlug}
      brokerLogoUrl={brokerLogoUrl}
      supportEmail={broker?.supportEmail ?? null}
    />
  );
}
