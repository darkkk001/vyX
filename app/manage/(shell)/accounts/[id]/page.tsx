import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { humanizeAction, excludeSuperAdminActor } from "@/lib/audit-labels";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

type TimelineRow = { time: Date; kind: string; tone: "success" | "danger" | "warning" | "neutral" | "info" | "accent"; summary: string };

// Client Activity -- Accounts was previously a flat table with no
// drill-in. Merges AuditLog (confirmed entityId is the account id for
// account-level actions, not a position id -- see adjust-balance/route.ts
// and accounts/[id]/route.ts), Transaction, Order, and Position history
// for this one account into one timestamp-sorted feed.
export default async function ClientActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  const account = await prisma.account.findUnique({
    where: { id },
    include: { group: { select: { name: true } }, kycRecord: { select: { status: true } } },
  });
  if (!account || account.brokerId !== brokerId) {
    notFound();
  }

  const [auditLogs, transactions, orders, positions] = await Promise.all([
    prisma.auditLog.findMany({ where: { entityId: id, brokerId, ...excludeSuperAdminActor }, orderBy: { createdAt: "desc" }, take: 50, include: { actorAdmin: { select: { email: true } } } }),
    prisma.transaction.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.order.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 50, include: { symbol: { select: { name: true } } } }),
    prisma.position.findMany({ where: { accountId: id }, orderBy: { openedAt: "desc" }, take: 50, include: { symbol: { select: { name: true } } } }),
  ]);

  const timeline: TimelineRow[] = [
    ...auditLogs.map((a): TimelineRow => ({
      time: a.createdAt,
      kind: "Admin action",
      tone: "accent",
      summary: `${humanizeAction(a.action)} — by ${a.actorAdmin?.email ?? "system"}`,
    })),
    ...transactions.map((t): TimelineRow => ({
      time: t.createdAt,
      kind: "Ledger",
      tone: t.amount.isNegative() ? "danger" : "success",
      summary: `${t.type} — ${t.amount.toString()} (${t.status})${t.note ? ` — ${t.note}` : ""}`,
    })),
    ...orders.map((o): TimelineRow => ({
      time: o.createdAt,
      kind: "Order",
      tone: o.status === "REJECTED" || o.status === "CANCELLED" ? "danger" : "info",
      summary: `${o.side} ${o.volume} ${o.symbol.name} ${o.type} — ${o.status}${o.rejectionReason ? ` (${o.rejectionReason})` : ""}`,
    })),
    ...positions.map((p): TimelineRow => ({
      time: p.openedAt,
      kind: "Position",
      tone: p.status === "OPEN" ? "warning" : "neutral",
      summary: `${p.side} ${p.volume} ${p.symbol.name} opened @ ${p.openPrice.toString()}${p.status === "CLOSED" ? ` — closed @ ${p.closePrice?.toString() ?? "—"}, P&L ${p.realizedPnl?.toString() ?? "—"}` : " — OPEN"}`,
    })),
  ].sort((a, b) => b.time.getTime() - a.time.getTime());

  return (
    <main className="mx-auto max-w-[1000px]">
      <PageHeader
        title={`${account.fullName} — ${account.accountNumber}`}
        description={`${account.email} · ${account.accountType} · ${account.status} · Group: ${account.group?.name ?? "ungrouped"} · KYC: ${account.kycRecord?.status ?? "none"}`}
      />
      <p className="mb-4">
        <Link href="/manage/accounts" className="text-sm text-[var(--accent)] hover:underline">
          ← Back to Accounts
        </Link>
      </p>
      <Table title="Activity" description="Most recent 50 of each type, merged and sorted by time.">
        <TableHead>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Details</TableHeaderCell>
          <TableHeaderCell>Time</TableHeaderCell>
        </TableHead>
        <TableBody>
          {timeline.length === 0 ? (
            <TableEmptyState colSpan={3}>No activity yet.</TableEmptyState>
          ) : (
            timeline.slice(0, 150).map((row, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Badge tone={row.tone}>{row.kind}</Badge>
                </TableCell>
                <TableCell className="text-sm">{row.summary}</TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.time.toISOString().replace("T", " ").slice(0, 19)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </main>
  );
}
