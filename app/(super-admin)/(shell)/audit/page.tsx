import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { humanizeAction } from "@/lib/audit-labels";
import { PageHeader } from "@/components/ui/PageHeader";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export default async function SuperAdminAuditPage() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 150,
    include: { actorAdmin: { select: { email: true } }, broker: { select: { name: true } } },
  });

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Audit log" description="Every platform-level and cross-tenant action, fully logged" />
      <Table>
        <TableHead>
          <TableHeaderCell>Actor</TableHeaderCell>
          <TableHeaderCell>Action</TableHeaderCell>
          <TableHeaderCell>Tenant</TableHeaderCell>
          <TableHeaderCell>Time</TableHeaderCell>
        </TableHead>
        <TableBody>
          {logs.length === 0 ? (
            <TableEmptyState colSpan={4}>No audit entries yet.</TableEmptyState>
          ) : (
            logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell primary>{log.actorAdmin?.email ?? "system"}</TableCell>
                <TableCell>{humanizeAction(log.action)}</TableCell>
                <TableCell className="text-[var(--text-3)]">{log.broker?.name ?? "—"}</TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{log.createdAt.toISOString().replace("T", " ").slice(0, 19)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </main>
  );
}
