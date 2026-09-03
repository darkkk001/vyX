import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import DealsManager from "./DealsManager";

// Every closed trade, browsable -- same underlying query as
// app/api/manage/reports/trading/route.ts's CSV export.
//
// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. DealsManager now fetches its own data from
// a new /api/manage/deals route.
export const metadata: Metadata = { title: "Deals — Backoffice" };

export default function ManagerDealsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Deals" />
      <DealsManager />
    </main>
  );
}
