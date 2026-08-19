import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

// No real LP fills exist anywhere in this app to compute slippage/
// rejection-rate/fill-rate from -- same honest "Not monitored" pattern
// as the Latency page. Deliberately does NOT repurpose the dealing-queue
// accept/reject data as a stand-in metric here -- that's the broker's
// own manual dealing desk, a different thing from LP execution quality,
// and presenting it under this heading would risk implying it's
// LP-related when it isn't.
export default async function ManagerLiquidityExecutionPage() {
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
      <PageHeader title="LP execution quality" description="No live LP fills exist yet -- this will show real slippage/rejection/fill-rate stats once they do." />
      <Table>
        <TableHead>
          <TableHeaderCell>Liquidity provider</TableHeaderCell>
          <TableHeaderCell align="right">Avg slippage</TableHeaderCell>
          <TableHeaderCell align="right">Rejection rate</TableHeaderCell>
          <TableHeaderCell align="right">Fill rate</TableHeaderCell>
        </TableHead>
        <TableBody>
          {providers.length === 0 ? (
            <TableEmptyState colSpan={4}>No liquidity providers on record yet.</TableEmptyState>
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
