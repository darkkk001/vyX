"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import NotificationsManager from "./NotificationsManager";

// Split out of page.tsx (VYX-BASICS-AUDIT.md category 6) -- a Client
// Component can't export `metadata`, and this page needs both: a real
// per-route browser-tab title AND router.refresh() after mark-read.
// page.tsx stays a Server Component so its metadata export is valid,
// and just renders this.
export default function NotificationsPageClient() {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description="Backoffice staff password-reset requests, across every broker." />
      <NotificationsManager onMutated={() => router.refresh()} />
    </main>
  );
}
