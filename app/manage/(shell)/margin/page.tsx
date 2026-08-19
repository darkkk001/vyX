import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAccountMarginSnapshots } from "@/lib/margin";
import { PageHeader } from "@/components/ui/PageHeader";
import MarginManager, { type MarginRow } from "./MarginManager";

// Every account with an open position, sorted most-at-risk first. Same
// computation as the Risk Dashboard stats and Risk report CSV
// (lib/margin.ts) -- this is the drill-down list, they're the summary.
export default async function ManagerMarginPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  const snapshots = await computeAccountMarginSnapshots(prisma, session!.brokerId!);
  const rows: MarginRow[] = snapshots
    .map((s) => ({
      accountId: s.accountId,
      accountNumber: s.accountNumber,
      positionCount: s.positionCount,
      exposure: s.exposure.toFixed(2),
      floatingPnl: (s.equity - s.balance).toFixed(2),
      marginLevel: s.marginLevel,
      marginCallLevel: s.marginCallLevel,
      stopOutLevel: s.stopOutLevel,
    }))
    .sort((a, b) => (a.marginLevel ?? Infinity) - (b.marginLevel ?? Infinity));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Margin monitoring"
        description="Every account with an open position, sorted most-at-risk first. Informational only — not yet enforced automatically."
      />
      <MarginManager rows={rows} />
    </main>
  );
}
