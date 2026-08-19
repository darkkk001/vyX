import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import LiquidityManager, { type LiquidityProviderRow } from "./LiquidityManager";

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

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Liquidity providers"
        description="Pre-integration roster only -- no real LP connection exists yet. Status is manually tracked, not detected."
      />
      <LiquidityManager initialRows={rows} />
    </main>
  );
}
