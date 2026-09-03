import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import LeadsManager from "./LeadsManager";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. LeadsManager now fetches its own data from
// the already-existing /api/manage/leads route.
export const metadata: Metadata = { title: "Leads — Backoffice" };

export default function ManagerLeadsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Leads" />
      <LeadsManager />
    </main>
  );
}
