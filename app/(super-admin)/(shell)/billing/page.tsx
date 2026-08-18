import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PLAN_PRICING, formatUsd } from "@/lib/billing";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

const statusTone = { TRIAL: "warning", ACTIVE: "success", SUSPENDED: "danger", DISABLED: "neutral" } as const;

// Config-only -- Plan/Monthly come from lib/billing.ts's PLAN_PRICING map,
// Billing status is derived from Broker.status, not a separate stored
// field. Not wired to any real payment processor; see Broker.
// nextInvoiceAt's own schema comment for what "Next invoice" actually is
// (a plain date field an admin action sets, not a real billing cycle).
export default async function BillingPage() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  const brokers = await prisma.broker.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <main className="mx-auto max-w-[1200px]">
      <PageHeader title="Plans & billing" description="Subscription status per broker — billing is separate from the trading ledger" />
      <Table>
        <TableHead>
          <TableHeaderCell>Broker</TableHeaderCell>
          <TableHeaderCell>Plan</TableHeaderCell>
          <TableHeaderCell align="right">Monthly</TableHeaderCell>
          <TableHeaderCell>Next invoice</TableHeaderCell>
          <TableHeaderCell>Billing status</TableHeaderCell>
        </TableHead>
        <TableBody>
          {brokers.length === 0 ? (
            <TableEmptyState colSpan={5}>No brokers yet.</TableEmptyState>
          ) : (
            brokers.map((b) => (
              <TableRow key={b.id}>
                <TableCell primary>{b.name}</TableCell>
                <TableCell>
                  <Badge tone={b.tier === "WHITE_LABEL" ? "accent" : "neutral"}>{PLAN_PRICING[b.tier].label}</Badge>
                </TableCell>
                <TableCell align="right" mono>
                  {formatUsd(PLAN_PRICING[b.tier].monthlyCents)}
                </TableCell>
                <TableCell className="text-[var(--text-3)]">
                  {b.status === "TRIAL" ? "Trial — no charge yet" : b.nextInvoiceAt ? b.nextInvoiceAt.toISOString().slice(0, 10) : "—"}
                </TableCell>
                <TableCell>
                  <Badge tone={statusTone[b.status]}>{b.status}</Badge>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </main>
  );
}
