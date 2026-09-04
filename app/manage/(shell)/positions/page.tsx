import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import PositionsManager from "./PositionsManager";
import LiveActivityFeed from "@/components/admin/LiveActivityFeed";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. PositionsManager now self-fetches everything
// (open positions + account/symbol/group/IB filter options) from a new
// GET on the already-existing /api/manage/positions route, and re-polls
// it on the same 5s interval this page's own router.refresh() used to
// drive, instead of a Server Component prop.
//
// LiveActivityFeed (2026-09-04 refinement, reversed same day): a
// dealer-scoped feed briefly lived here, was pulled as clutter, and is
// back as a platform-wide one instead -- every account's activity, not
// just DEALING-group ones. The dealer's own DEALING-only view (plus the
// resting-orders panel) stays exclusively on the Dealing page's Activity
// tab (components/admin/DealingDeskPanel.tsx), where the dealer actually
// works -- this page's own feed is a different, broker-wide surface, not
// a duplicate of that one.
export const metadata: Metadata = { title: "Live Exposure — Backoffice" };

export default function ManagerPositionsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Live Exposure" />
      <div className="flex flex-col gap-6">
        <PositionsManager />
        <LiveActivityFeed />
      </div>
    </main>
  );
}
