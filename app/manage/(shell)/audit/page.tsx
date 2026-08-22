import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { humanizeAction, auditEntityHref } from "@/lib/audit-labels";
import { PageHeader } from "@/components/ui/PageHeader";
import AuditLogTable, { type AuditLogRow } from "./AuditLogTable";

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

  const rows: AuditLogRow[] = logs.map((log) => ({
    id: log.id,
    actorEmail: log.actorAdmin?.email ?? "system",
    actionLabel: humanizeAction(log.action),
    entityType: log.entityType,
    entityId: log.entityId,
    href: auditEntityHref(log.entityType, log.entityId),
    createdAtLabel: log.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Audit log" description="Every sensitive action taken by broker staff, fully logged. Double-click a row to open what it changed." />
      <AuditLogTable rows={rows} />
    </main>
  );
}
