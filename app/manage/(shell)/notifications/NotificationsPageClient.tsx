"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import NotificationsManager from "./NotificationsManager";

// Split out of page.tsx (VYX-BASICS-AUDIT.md category 6) -- a Client
// Component can't export `metadata`, and this page needs both: a real
// per-route browser-tab title AND router.refresh() after mark-read (see
// this component's own history in page.tsx before the split for why
// that's needed). page.tsx stays a Server Component so its metadata
// export is valid, and just renders this.
export default function NotificationsPageClient() {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description="System-generated alerts for new leads, KYC submissions, funds requests, and dealing-queue orders." />
      <NotificationsManager onMutated={() => router.refresh()} />
    </main>
  );
}
