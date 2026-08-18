import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { Table, TableHead, TableHeaderCell, TableBody, TableEmptyState } from "@/components/ui/Table";
import TrialsManager, { type TrialRow } from "./TrialsManager";

export default async function TrialsPage() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  const brokers = await prisma.broker.findMany({
    where: { status: "TRIAL" },
    orderBy: { createdAt: "desc" },
  });

  const rows: TrialRow[] = brokers.map((b) => ({
    id: b.id,
    name: b.name,
    createdAt: b.createdAt.toISOString().slice(0, 10),
    trialEndsAt: b.trialEndsAt ? b.trialEndsAt.toISOString().slice(0, 10) : "—",
  }));

  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader title="Trials pending" description="Brokers currently on a trial period" />
      {rows.length === 0 ? (
        <Table>
          <TableHead>
            <TableHeaderCell>Broker</TableHeaderCell>
            <TableHeaderCell>Trial started</TableHeaderCell>
            <TableHeaderCell>Trial ends</TableHeaderCell>
            <TableHeaderCell />
          </TableHead>
          <TableBody>
            <TableEmptyState colSpan={4}>No trials pending.</TableEmptyState>
          </TableBody>
        </Table>
      ) : (
        <TrialsManager initialRows={rows} />
      )}
    </main>
  );
}
