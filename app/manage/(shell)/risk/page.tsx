import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import RiskSettingsManager from "./RiskSettingsManager";

// Finance/ops-tier screen -- same BROKER_ADMIN-only carve-out as
// Funds/KYC/IB/Team, not the broader MANAGER+BROKER_ADMIN gate. See
// lib/risk.ts for how these settings are actually enforced on the live
// trading path (app/api/trade/orders, app/api/manage/positions).
export default async function ManagerRiskPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session!.brokerId! } });

  return (
    <main className="mx-auto max-w-2xl">
      <PageHeader
        title="Risk"
        description="Broker-wide trading controls. Existing open positions are never touched by these — they only affect new orders."
      />
      <RiskSettingsManager
        initial={{
          tradingHalted: broker.tradingHaltedAt != null,
          totalExposureLimit: broker.totalExposureLimit ? broker.totalExposureLimit.toString() : null,
          maxOpenPositionsPerAccount: broker.maxOpenPositionsPerAccount,
        }}
      />
    </main>
  );
}
