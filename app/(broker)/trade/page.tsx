import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAccountSession } from "@/lib/account-auth";
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

  return <WebTrader brokerName={brokerSlug} brokerLogoUrl={brokerLogoUrl} />;
}
