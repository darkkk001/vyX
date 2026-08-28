import { PageHeader } from "@/components/ui/PageHeader";
import NotificationsManager from "./NotificationsManager";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN-only guard is identical to what
// this page checked itself. NotificationsManager now fetches its own
// data from the already-existing /api/admin/notifications route.
export default function SuperAdminNotificationsPage() {
  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description="Backoffice staff password-reset requests, across every broker." />
      <NotificationsManager />
    </main>
  );
}
