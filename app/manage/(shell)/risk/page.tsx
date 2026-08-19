import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAccountMarginSnapshots } from "@/lib/margin";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
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
  const brokerId = session!.brokerId!;

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
  const snapshots = await computeAccountMarginSnapshots(prisma, brokerId);

  const totalExposure = snapshots.reduce((s, a) => s + a.exposure, 0);
  const totalFloatingPnl = snapshots.reduce((s, a) => s + (a.equity - a.balance), 0);
  const openPositions = snapshots.reduce((s, a) => s + a.positionCount, 0);
  const atStopOut = snapshots.filter((a) => a.marginLevel != null && a.marginLevel < a.stopOutLevel).length;
  const atMarginCall = snapshots.filter((a) => a.marginLevel != null && a.marginLevel >= a.stopOutLevel && a.marginLevel < a.marginCallLevel).length;

  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader
        title="Risk"
        description="Broker-wide trading controls. Existing open positions are never touched by these — they only affect new orders."
      />
      <div className="mb-6">
        <StatGrid columns={4}>
          <StatCard label="Open exposure" value={`${totalExposure.toLocaleString("en-US")} lots`} />
          <StatCard label="Floating P&L" value={`${totalFloatingPnl >= 0 ? "+" : ""}${totalFloatingPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          <StatCard label="Open positions" value={String(openPositions)} />
          <StatCard label="Accounts at risk" value={`${atMarginCall + atStopOut}`} />
        </StatGrid>
        <p className="mt-2 text-xs text-[var(--text-3)]">
          {atStopOut} account{atStopOut === 1 ? "" : "s"} below stop-out, {atMarginCall} below margin call — informational only, not yet enforced automatically (see Group.stopOutLevel). Full list on the Margin page.
        </p>
      </div>
      <RiskSettingsManager
        initial={{
          dealingMode: broker.dealingModeAt != null,
          totalExposureLimit: broker.totalExposureLimit ? broker.totalExposureLimit.toString() : null,
          maxOpenPositionsPerAccount: broker.maxOpenPositionsPerAccount,
        }}
      />
    </main>
  );
}
