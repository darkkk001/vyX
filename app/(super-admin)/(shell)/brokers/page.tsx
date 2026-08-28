import { PageHeader } from "@/components/ui/PageHeader";
import BrokersManager from "./BrokersManager";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN guard is identical to what this
// page checked itself. BrokersManager now self-fetches from the
// already-existing (and previously entirely unused) /api/admin/brokers
// GET, reshaped to return { rows, totalEndClients } -- the stat grid's
// numbers are now derived client-side from rows, same pattern
// RiskSettingsManager uses deriving its own stats from Margin's rows.
export default function BrokersPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="All brokers" description="Every broker tenant licensed on VyXTrader" />
      <BrokersManager />
    </main>
  );
}
