import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import LiquidityManager, { type LiquidityProviderRow, type BookExposureRow } from "./LiquidityManager";

// BROKER_ADMIN only, not delegatable -- structural business/contractual
// decisions, same category as Team/Settings. Pre-integration record-
// keeping only -- see LiquidityProvider's schema comment.
export default async function ManagerLiquidityPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const providers = await prisma.liquidityProvider.findMany({
    where: { brokerId },
    include: { _count: { select: { routingRules: true } } },
    orderBy: { createdAt: "desc" },
  });

  const rows: LiquidityProviderRow[] = providers.map((p) => ({
    id: p.id,
    name: p.name,
    contactName: p.contactName,
    contactEmail: p.contactEmail,
    contactPhone: p.contactPhone,
    protocol: p.protocol,
    status: p.status,
    notes: p.notes,
    routingRuleCount: p._count.routingRules,
    createdAt: p.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  // Real numbers from real open Position rows -- unlike Liquidity
  // Latency/Execution-Quality (deliberately "Not monitored"), this is
  // something the app actually knows: which book each open position was
  // stamped into at fill time (BrokerSymbol.defaultBookType).
  const grouped = await prisma.position.groupBy({
    by: ["symbolId", "bookType"],
    where: { brokerId, status: "OPEN" },
    _sum: { volume: true },
  });
  const symbolIds = [...new Set(grouped.map((g) => g.symbolId))];
  const symbols = await prisma.symbol.findMany({ where: { id: { in: symbolIds } }, select: { id: true, name: true } });
  const nameById = new Map(symbols.map((s) => [s.id, s.name]));
  const bookExposureBySymbol = new Map<string, BookExposureRow>();
  for (const g of grouped) {
    const name = nameById.get(g.symbolId) ?? g.symbolId;
    const existing = bookExposureBySymbol.get(name) ?? { symbol: name, aBookVolume: "0", bBookVolume: "0" };
    const volume = (g._sum.volume ?? 0).toString();
    if (g.bookType === "A_BOOK") existing.aBookVolume = volume;
    else existing.bBookVolume = volume;
    bookExposureBySymbol.set(name, existing);
  }
  const bookExposure = [...bookExposureBySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Liquidity providers"
        description="Pre-integration roster only -- no real LP connection exists yet. Status is manually tracked, not detected."
      />
      <LiquidityManager initialRows={rows} bookExposure={bookExposure} />
    </main>
  );
}
