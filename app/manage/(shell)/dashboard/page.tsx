import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import DashboardManager from "./DashboardManager";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. DashboardManager now self-fetches from a new
// /api/manage/dashboard GET instead of everything being computed and
// rendered inline in this Server Component.
export const metadata: Metadata = { title: "Dashboard - Backoffice" };

export default function ManagerDashboardPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Dashboard" description="Overview of your brokerage - last updated just now" />
      <DashboardManager />
    </main>
  );
}
