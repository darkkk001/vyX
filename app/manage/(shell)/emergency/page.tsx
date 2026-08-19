import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import EmergencyControls from "./EmergencyControls";

// BROKER_ADMIN only -- same carve-out as Risk (this is the same
// broker-wide policy surface, just the kill switch half of it).
export default async function ManagerEmergencyPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session!.brokerId! } });

  return (
    <main className="mx-auto max-w-2xl">
      <PageHeader title="Emergency controls" description="The broker-wide kill switch. Existing open positions are never touched by this — it only blocks new orders." />
      <EmergencyControls initialTradingHalted={broker.tradingHaltedAt != null} />
    </main>
  );
}
