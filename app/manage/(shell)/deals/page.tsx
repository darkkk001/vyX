import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import DealsManager, { type DealRow } from "./DealsManager";

// Every closed trade, browsable -- same underlying query as
// app/api/manage/reports/trading/route.ts's CSV export (Position where
// status: CLOSED), just rendered as a table instead of only downloadable.
// MANAGER + BROKER_ADMIN, same as Positions (this is the closed-position
// half of the same dealing-desk activity).
export default async function ManagerDealsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const positions = await prisma.position.findMany({
    where: { brokerId, status: "CLOSED" },
    include: {
      account: { select: { accountNumber: true, fullName: true } },
      symbol: { select: { name: true, digits: true } },
    },
    orderBy: { closedAt: "desc" },
    take: 500,
  });

  const rows: DealRow[] = positions.map((p) => ({
    id: p.id,
    accountNumber: p.account.accountNumber,
    accountFullName: p.account.fullName,
    symbol: p.symbol.name,
    digits: p.symbol.digits,
    side: p.side,
    volume: p.volume.toString(),
    openPrice: p.openPrice.toFixed(p.symbol.digits),
    closePrice: p.closePrice ? p.closePrice.toFixed(p.symbol.digits) : "—",
    commission: p.commission.toFixed(2),
    swap: p.swap.toFixed(2),
    realizedPnl: p.realizedPnl ? p.realizedPnl.toFixed(2) : "—",
    closedAt: p.closedAt ? p.closedAt.toISOString().replace("T", " ").slice(0, 19) : "—",
  }));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Deals" description={`${rows.length} closed trade${rows.length === 1 ? "" : "s"} (most recent 500) across this broker.`} />
      <DealsManager initialRows={rows} />
    </main>
  );
}
