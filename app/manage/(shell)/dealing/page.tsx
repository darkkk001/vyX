import { PageHeader } from "@/components/ui/PageHeader";
import DealingQueueManager from "./DealingQueueManager";

// Trader-submitted MARKET orders waiting for a dealer's Accept/Reject --
// only populated while Broker.dealingModeAt is set. Same MANAGER/
// BROKER_ADMIN pair as Positions' manual open/close.
//
// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. DealingQueueManager now fetches its own
// data from a new /api/manage/dealing-queue GET.
export default function ManagerDealingPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Dealing queue" />
      <DealingQueueManager />
    </main>
  );
}
