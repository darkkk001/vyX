import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { humanizeAction } from "@/lib/audit-labels";
import { PageHeader } from "@/components/ui/PageHeader";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export default async function ManagerAuditPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const logs = await prisma.auditLog.findMany({
    where: { brokerId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { actorAdmin: { select: { email: true } } },
  });

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Audit log" description="Every sensitive action taken by broker staff, fully logged" />
      <Table>
        <TableHead>
          <TableHeaderCell>Staff member</TableHeaderCell>
          <TableHeaderCell>Action</TableHeaderCell>
          <TableHeaderCell>Target</TableHeaderCell>
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
                <TableCell mono className="text-[var(--text-3)]">
                  {log.entityType} · {log.entityId}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{log.createdAt.toISOString().replace("T", " ").slice(0, 19)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </main>
  );
}
