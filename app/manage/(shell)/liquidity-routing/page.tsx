import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import LpRoutingManager, { type RoutingRuleRow, type LpOption, type SymbolOption } from "./LpRoutingManager";

// BROKER_ADMIN only, same carve-out as the LP roster. Intended routing,
// not live routing -- see LpRoutingRule's schema comment.
export default async function ManagerLpRoutingPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const [rules, providers, symbols] = await Promise.all([
    prisma.lpRoutingRule.findMany({
      where: { brokerId },
      include: { liquidityProvider: { select: { name: true, status: true } }, symbol: { select: { name: true } } },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    }),
    prisma.liquidityProvider.findMany({ where: { brokerId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.symbol.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const rows: RoutingRuleRow[] = rules.map((r) => ({
    id: r.id,
    liquidityProviderName: r.liquidityProvider.name,
    liquidityProviderStatus: r.liquidityProvider.status,
    symbolName: r.symbol?.name ?? null,
    priority: r.priority,
    notes: r.notes,
  }));

  const lpOptions: LpOption[] = providers.map((p) => ({ id: p.id, name: p.name }));
  const symbolOptions: SymbolOption[] = symbols.map((s) => ({ id: s.id, name: s.name }));

  return (
    <main className="mx-auto max-w-[1200px]">
      <PageHeader
        title="LP routing rules"
        description="Intended routing, recorded before the real integration exists -- no execution path reads this yet."
      />
      <LpRoutingManager initialRows={rows} lpOptions={lpOptions} symbolOptions={symbolOptions} />
    </main>
  );
}
