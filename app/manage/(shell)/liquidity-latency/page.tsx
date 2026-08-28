import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import LatencyManager from "./LatencyManager";

// BROKER_ADMIN only, not delegatable -- same gate as
// /api/manage/liquidity-providers itself. Kept its own check here --
// stricter than the shell layout's own MANAGER-or-BROKER_ADMIN guard,
// same reasoning as Settings/Emergency/Transfers. Data now self-fetched
// by LatencyManager from that already-existing route.
export default async function ManagerLiquidityLatencyPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="LP latency" description="No live LP connection exists yet -- this will show real measurements once one does." />
      <LatencyManager />
    </main>
  );
}
