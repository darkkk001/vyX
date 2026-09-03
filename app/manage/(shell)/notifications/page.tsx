import type { Metadata } from "next";
import NotificationsPageClient from "./NotificationsPageClient";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. Kept as a Server Component (unlike its
// former single-file self) purely so `metadata` below is valid --
// everything else lives in NotificationsPageClient.tsx, which needs
// "use client" for router.refresh().
export const metadata: Metadata = { title: "Notifications — Backoffice" };

export default function ManagerNotificationsPage() {
  return <NotificationsPageClient />;
}
