import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { humanizeAction, excludeSuperAdminActor } from "@/lib/audit-labels";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function ManagerDashboardPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

  const [
    totalClients,
    newClients7d,
    depositsSum,
    activeTrades,
    activeTradeAccounts,
    pendingKyc,
    pendingWithdrawals,
    activity,
  ] = await Promise.all([
    prisma.account.count({ where: { brokerId } }),
    prisma.account.count({ where: { brokerId, createdAt: { gte: sevenDaysAgo } } }),
    prisma.transaction.aggregate({
      where: { brokerId, type: "DEPOSIT", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo } },
      _sum: { amount: true },
    }),
    prisma.position.count({ where: { brokerId, status: "OPEN" } }),
    prisma.position.findMany({ where: { brokerId, status: "OPEN" }, select: { accountId: true }, distinct: ["accountId"] }),
    prisma.kycRecord.count({ where: { status: "PENDING", account: { brokerId } } }),
    prisma.transaction.aggregate({
      where: { brokerId, type: "WITHDRAWAL", status: "PENDING" },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.auditLog.findMany({
      where: { brokerId, ...excludeSuperAdminActor },
      orderBy: { createdAt: "desc" },
      take: 15,
      include: { actorAdmin: { select: { email: true } } },
    }),
  ]);

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Dashboard" description="Overview of your brokerage — last updated just now" />
      <StatGrid columns={5}>
        <StatCard
          label="Total clients"
          value={totalClients.toLocaleString("en-US")}
          delta={newClients7d > 0 ? `+${newClients7d} this week` : undefined}
          deltaTone="pos"
        />
        <StatCard label="Total deposits (30d)" value={`$${(depositsSum._sum.amount?.toNumber() ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`} />
        <StatCard label="Active trades" value={String(activeTrades)} delta={`across ${activeTradeAccounts.length} clients`} />
        <StatCard label="Pending KYC" value={String(pendingKyc)} valueTone={pendingKyc > 0 ? "warn" : undefined} delta={pendingKyc > 0 ? "needs review" : undefined} deltaTone="warn" />
        <StatCard
          label="Pending withdrawals"
          value={String(pendingWithdrawals._count)}
          valueTone={pendingWithdrawals._count > 0 ? "warn" : undefined}
          delta={pendingWithdrawals._count > 0 ? `$${(pendingWithdrawals._sum.amount?.toNumber() ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} total` : undefined}
          deltaTone="warn"
        />
      </StatGrid>

      <Table title="Recent activity">
        <TableHead>
          <TableHeaderCell>Event</TableHeaderCell>
          <TableHeaderCell>Staff</TableHeaderCell>
          <TableHeaderCell>Target</TableHeaderCell>
          <TableHeaderCell>Time</TableHeaderCell>
        </TableHead>
        <TableBody>
          {activity.length === 0 ? (
            <TableEmptyState colSpan={4}>No recent activity.</TableEmptyState>
          ) : (
            activity.map((a) => (
              <TableRow key={a.id}>
                <TableCell primary>{humanizeAction(a.action)}</TableCell>
                <TableCell className="text-[var(--text-3)]">{a.actorAdmin?.email ?? "system"}</TableCell>
                <TableCell mono className="text-[var(--text-3)]">
                  {a.entityId}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{a.createdAt.toISOString().replace("T", " ").slice(0, 19)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </main>
  );
}
