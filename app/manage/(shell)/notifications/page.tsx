import { PageHeader } from "@/components/ui/PageHeader";
import NotificationsManager from "./NotificationsManager";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. NotificationsManager now fetches its own
// data from the already-existing /api/manage/notifications route.
export default function ManagerNotificationsPage() {
  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description="System-generated alerts for new leads, KYC submissions, funds requests, and dealing-queue orders." />
      <NotificationsManager />
    </main>
  );
}
