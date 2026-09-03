"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import NotificationsManager from "./NotificationsManager";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. NotificationsManager now fetches its own
// data from the already-existing /api/manage/notifications route.
//
// "use client" (added alongside NotificationsManager's new onMutated
// prop) so this page can call router.refresh() after a mark-read --
// layout.tsx's sidebar unread-count badge is a Server Component read,
// otherwise stuck at whatever count was true on the last navigation.
export default function ManagerNotificationsPage() {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description="System-generated alerts for new leads, KYC submissions, funds requests, and dealing-queue orders." />
      <NotificationsManager onMutated={() => router.refresh()} />
    </main>
  );
}
