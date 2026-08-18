import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import SymbolConfigTable, { type SymbolConfigRow } from "./SymbolConfigTable";

// Same schema defaults as app/api/manage/symbols/route.ts's DEFAULTS --
// duplicated rather than imported across a route-handler/page boundary,
// matching this codebase's existing preference for each Next.js
// entrypoint reading Prisma directly rather than sharing fetch logic
// (see app/(super-admin)/brokers/page.tsx, which queries Prisma directly
// too instead of calling its own GET /api/admin/brokers).
const DEFAULTS = {
  spreadMarkup: "0",
  minLot: "0.01",
  maxLot: "100",
  lotStep: "0.01",
  swapLong: "0",
  swapShort: "0",
  enabled: true,
  commissionPerLot: "0",
  maxExposure: null as string | null,
  tradingMode: "BOTH" as const,
};

export default async function ManagerSymbolsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const symbols = await prisma.symbol.findMany({
    orderBy: { name: "asc" },
    include: { brokerSymbols: { where: { brokerId } } },
  });

  const rows: SymbolConfigRow[] = symbols.map((symbol) => {
    const cfg = symbol.brokerSymbols[0];
    return {
      symbolId: symbol.id,
      symbolName: symbol.name,
      category: symbol.category,
      digits: symbol.digits,
      spreadMarkup: cfg ? cfg.spreadMarkup.toString() : DEFAULTS.spreadMarkup,
      minLot: cfg ? cfg.minLot.toString() : DEFAULTS.minLot,
      maxLot: cfg ? cfg.maxLot.toString() : DEFAULTS.maxLot,
      lotStep: cfg ? cfg.lotStep.toString() : DEFAULTS.lotStep,
      swapLong: cfg ? cfg.swapLong.toString() : DEFAULTS.swapLong,
      swapShort: cfg ? cfg.swapShort.toString() : DEFAULTS.swapShort,
      enabled: cfg ? cfg.enabled : DEFAULTS.enabled,
      commissionPerLot: cfg ? cfg.commissionPerLot.toString() : DEFAULTS.commissionPerLot,
      maxExposure: cfg ? (cfg.maxExposure ? cfg.maxExposure.toString() : null) : DEFAULTS.maxExposure,
      tradingMode: cfg ? cfg.tradingMode : DEFAULTS.tradingMode,
    };
  });

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Symbols"
        description="Spread markup, lot limits, swap, and commission per symbol for this broker. A symbol with no saved row yet shows the platform default — saving it creates the row."
      />
      <SymbolConfigTable initialRows={rows} />
    </main>
  );
}
