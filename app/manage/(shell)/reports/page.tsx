import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
import ReportsView from "./ReportsView";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function ManagerReportsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

  const [volumeAgg, commissionAgg, depositsAgg, withdrawalsAgg, newClients] = await Promise.all([
    prisma.position.aggregate({ where: { brokerId, openedAt: { gte: thirtyDaysAgo } }, _sum: { volume: true } }),
    // "Spread revenue" in the design reference -- relabeled here since
    // spread markup isn't booked as a discrete ledger row anywhere,
    // only Position.commission is a real, queryable number.
    prisma.position.aggregate({ where: { brokerId, status: "CLOSED", closedAt: { gte: thirtyDaysAgo } }, _sum: { commission: true } }),
    prisma.transaction.aggregate({ where: { brokerId, type: "DEPOSIT", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo } }, _sum: { amount: true } }),
    prisma.transaction.aggregate({ where: { brokerId, type: "WITHDRAWAL", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo } }, _sum: { amount: true } }),
    prisma.account.count({ where: { brokerId, createdAt: { gte: thirtyDaysAgo } } }),
  ]);

  const netDeposits = (depositsAgg._sum.amount?.toNumber() ?? 0) - Math.abs(withdrawalsAgg._sum.amount?.toNumber() ?? 0);

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Reports" description="Trading volume, revenue, and client acquisition — trailing 30 days" />
      <StatGrid columns={4}>
        <StatCard label="Trading volume (30d)" value={`${(volumeAgg._sum.volume?.toNumber() ?? 0).toLocaleString("en-US")} lots`} />
        <StatCard label="Commission revenue (30d)" value={`$${(commissionAgg._sum.commission?.toNumber() ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`} />
        <StatCard label="Net deposits (30d)" value={`$${netDeposits.toLocaleString("en-US", { minimumFractionDigits: 2 })}`} />
        <StatCard label="New clients (30d)" value={String(newClients)} />
      </StatGrid>
      <ReportsView />
    </main>
  );
}
