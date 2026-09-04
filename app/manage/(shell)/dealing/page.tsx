import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import DealingTabs from "./DealingTabs";
import DealerDeskToggle from "@/components/admin/DealerDeskToggle";

// Trader-submitted MARKET orders waiting for a dealer's Accept/Reject,
// only populated while Broker.dealingModeAt is set, a group's own
// dealingMode routes it there, or (2026-09-04) the Dealer switch above is
// ON. Same MANAGER/BROKER_ADMIN pair as Positions' manual open/close.
//
// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. The "Mirror" tab is visible to every
// MANAGER/BROKER_ADMIN viewer here, same as the queue tab -- the
// underlying /api/manage/mirror-rules routes are the actual
// MIRROR_MANAGE gate (docs/briefs/VYX-MIRROR-V0-BRIEF.md).
export const metadata: Metadata = { title: "Dealing - Backoffice" };

export default function ManagerDealingPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Dealing" />
      <div className="mb-6">
        <DealerDeskToggle />
      </div>
      <DealingTabs />
    </main>
  );
}
