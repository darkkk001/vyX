import type { Metadata } from "next";
import NotificationsPageClient from "./NotificationsPageClient";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN-only guard is identical to what
// this page checked itself. Kept as a Server Component purely so
// `metadata` below is valid -- everything else lives in
// NotificationsPageClient.tsx, which needs "use client" for
// router.refresh().
export const metadata: Metadata = { title: "Notifications - Super Admin" };

export default function SuperAdminNotificationsPage() {
  return <NotificationsPageClient />;
}
