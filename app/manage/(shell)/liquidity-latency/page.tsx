import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

// No real LP connection exists anywhere in this app (blocked on an
// actual LP relationship -- see docs/architecture.md's Phase 5 status),
// so there's nothing to measure. Same honest "Not monitored" pattern as
// Super Admin's Platform Health page (app/(super-admin)/(shell)/health/
// page.tsx) -- real when real, "Not monitored" instead of invented
// numbers when it isn't.
export default async function ManagerLiquidityLatencyPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  const providers = await prisma.liquidityProvider.findMany({
    where: { brokerId: session!.brokerId! },
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  });

  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="LP latency" description="No live LP connection exists yet -- this will show real measurements once one does." />
      <Table>
        <TableHead>
          <TableHeaderCell>Liquidity provider</TableHeaderCell>
          <TableHeaderCell align="right">Round-trip latency</TableHeaderCell>
          <TableHeaderCell align="right">Uptime (30d)</TableHeaderCell>
        </TableHead>
        <TableBody>
          {providers.length === 0 ? (
            <TableEmptyState colSpan={3}>No liquidity providers on record yet.</TableEmptyState>
          ) : (
            providers.map((p) => (
              <TableRow key={p.id}>
                <TableCell primary>
                  {p.name} <Badge tone="neutral">{p.status}</Badge>
                </TableCell>
                <TableCell align="right" mono>
                  <Badge tone="neutral">Not monitored</Badge>
                </TableCell>
                <TableCell align="right" mono>
                  <Badge tone="neutral">Not monitored</Badge>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </main>
  );
}
