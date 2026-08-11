import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/account-auth";
import WebTrader from "@/components/webtrader/WebTrader";
import "./webtrader.css";

export default async function TradePage() {
  const session = await getAccountSession();
  if (!session) {
    redirect("/trade/login");
  }

  return <WebTrader />;
}
