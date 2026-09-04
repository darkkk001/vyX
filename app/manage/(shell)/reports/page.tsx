import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import ReportsView from "./ReportsView";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. ReportsView now fetches its own stat-grid
// data from /api/manage/reports/summary.
export const metadata: Metadata = { title: "Reports - Backoffice" };

export default function ManagerReportsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Reports" description="Trading volume, revenue, and client acquisition - trailing 30 days" />
      <ReportsView />
    </main>
  );
}
