import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import PositionsManager from "./PositionsManager";
import DealerActivityFeed from "@/components/admin/DealerActivityFeed";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. PositionsManager now self-fetches everything
// (open positions + account/symbol/group/IB filter options) from a new
// GET on the already-existing /api/manage/positions route, and re-polls
// it on the same 5s interval this page's own router.refresh() used to
// drive, instead of a Server Component prop.
export const metadata: Metadata = { title: "Live Exposure — Backoffice" };

export default function ManagerPositionsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Live Exposure" />
      <div className="flex flex-col gap-6">
        <PositionsManager />
        <DealerActivityFeed />
      </div>
    </main>
  );
}
