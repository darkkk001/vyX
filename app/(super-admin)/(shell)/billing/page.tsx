import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import BillingManager from "./BillingManager";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN guard is identical to what this
// page checked itself. BillingManager now self-fetches from the same
// /api/admin/brokers GET BrokersManager/TrialsManager use.
export const metadata: Metadata = { title: "Plans & billing — Super Admin" };

export default function BillingPage() {
  return (
    <main className="mx-auto max-w-[1200px]">
      <PageHeader title="Plans & billing" description="Subscription status per broker — billing is separate from the trading ledger" />
      <BillingManager />
    </main>
  );
}
