import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import NotificationsManager, { type NotificationRow } from "./NotificationsManager";

export default async function SuperAdminNotificationsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    redirect("/login");
  }

  const notifications = await prisma.notification.findMany({
    where: { type: "ADMIN_PASSWORD_RESET_REQUESTED" },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { broker: { select: { name: true } } },
  });

  const rows: NotificationRow[] = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    brokerName: n.broker.name,
    entityType: n.entityType,
    entityId: n.entityId,
    read: n.readAt != null,
    createdAt: n.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description="Backoffice staff password-reset requests, across every broker." />
      <NotificationsManager initialRows={rows} />
    </main>
  );
}
