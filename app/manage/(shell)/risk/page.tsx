import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import RiskSettingsManager from "./RiskSettingsManager";

// BROKER_ADMIN by default, same finance/ops carve-out as Funds/KYC/IB/
// Team -- delegatable via RISK_SETTINGS (see lib/permissions.ts). See
// lib/risk.ts for how these settings are actually enforced on the live
// trading path. Kept its own check here -- stricter than the shell
// layout's own MANAGER-or-BROKER_ADMIN guard, same recurring reasoning.
export const metadata: Metadata = { title: "Risk - Backoffice" };

export default async function ManagerRiskPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "RISK_SETTINGS")) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader
        title="Risk"
        description="Broker-wide trading controls. Existing open positions are never touched by these, they only affect new orders."
      />
      <RiskSettingsManager />
    </main>
  );
}
