import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import TrialsManager from "./TrialsManager";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN guard is identical to what this
// page checked itself. TrialsManager now self-fetches from the same
// /api/admin/brokers GET BrokersManager uses and filters to TRIAL
// status client-side, instead of a separate Prisma query here -- the
// empty-state table used to live in this Server Component; that's moved
// into TrialsManager too since it now owns loading/empty state itself.
export const metadata: Metadata = { title: "Trials pending - Super Admin" };

export default function TrialsPage() {
  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader title="Trials pending" description="Brokers currently on a trial period" />
      <TrialsManager />
    </main>
  );
}
