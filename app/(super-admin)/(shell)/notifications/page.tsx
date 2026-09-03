"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import NotificationsManager from "./NotificationsManager";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN-only guard is identical to what
// this page checked itself. NotificationsManager now fetches its own
// data from the already-existing /api/admin/notifications route.
//
// "use client" (added alongside NotificationsManager's new onMutated
// prop) so this page can call router.refresh() after a mark-read --
// layout.tsx's sidebar unread-count badge is a Server Component read,
// otherwise stuck at whatever count was true on the last navigation.
export default function SuperAdminNotificationsPage() {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description="Backoffice staff password-reset requests, across every broker." />
      <NotificationsManager onMutated={() => router.refresh()} />
    </main>
  );
}
