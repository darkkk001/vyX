import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import MarginManager from "./MarginManager";

// No auth check or computation here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. MarginManager now fetches its own data from
// /api/manage/margin.
export const metadata: Metadata = { title: "Margin monitoring — Backoffice" };

export default function ManagerMarginPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Margin monitoring"
        description="Every account with an open position, sorted most-at-risk first. Informational only — not yet enforced automatically."
      />
      <MarginManager />
    </main>
  );
}
