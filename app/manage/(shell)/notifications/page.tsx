import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import NotificationsManager, { type NotificationRow } from "./NotificationsManager";

export default async function ManagerNotificationsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  const notifications = await prisma.notification.findMany({
    where: { brokerId: session!.brokerId! },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const rows: NotificationRow[] = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    read: n.readAt != null,
    createdAt: n.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description="System-generated alerts for new leads, KYC submissions, funds requests, and dealing-queue orders." />
      <NotificationsManager initialRows={rows} />
    </main>
  );
}
