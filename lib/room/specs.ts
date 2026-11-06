import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { markupSplit, pipSize } from "@/lib/group-pricing";
import { getLivePriceRows } from "@/lib/live-price";
import { hoursSummary } from "@/lib/symbol-sessions";
import { symbolVisibility } from "@/lib/synthetic-symbols";
import { roomPlans } from "@/lib/room/plans";

// Trader's Room Contract specifications: per plan, per symbol, from the broker's live configuration. Nothing here is typed in.
// The spread is the live one (raw + the plan's markup): no spread history is recorded, so a typical figure does not exist yet.
// Only the client's total is sent, never the raw spread or the markup on their own.
export type SpecRow = { symbol: string; category: string; spreadPips: string | null; commissionPerLot: string | null; contractSize: string; hours: string };
export type SpecPlan = { name: string; rows: SpecRow[] };

export async function roomSpecs(brokerId: string): Promise<SpecPlan[]> {
  const [plans, broker, brokerSymbols, visible] = await Promise.all([
    roomPlans(brokerId, "LIVE"),
    prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { timeZone: true } }),
    prisma.brokerSymbol.findMany({ where: { brokerId, enabled: true }, include: { symbol: true, tradingSessions: true }, orderBy: { symbol: { name: "asc" } } }),
    symbolVisibility(prisma, brokerId),
  ]);
  const shown = brokerSymbols.filter((bs) => visible(bs.symbol.name));
  const [prices, groups, configs, allowed] = await Promise.all([
    getLivePriceRows(shown.map((bs) => bs.symbol.name)),
    prisma.group.findMany({ where: { id: { in: plans.map((p) => p.groupId) } }, select: { id: true, restrictSymbols: true } }),
    prisma.groupSymbolConfig.findMany({ where: { groupId: { in: plans.map((p) => p.groupId) } } }),
    prisma.groupSymbol.findMany({ where: { groupId: { in: plans.map((p) => p.groupId) } }, select: { groupId: true, symbolId: true } }),
  ]);
  const restricted = new Set(groups.filter((g) => g.restrictSymbols).map((g) => g.id));
  const allow = new Set(allowed.map((a) => `${a.groupId}|${a.symbolId}`));
  const config = new Map(configs.map((c) => [`${c.groupId}|${c.symbolId}`, c]));

  return plans.map((plan) => ({
    name: plan.name,
    rows: shown.filter((bs) => !restricted.has(plan.groupId) || allow.has(`${plan.groupId}|${bs.symbolId}`)).map((bs) => {
      const c = config.get(`${plan.groupId}|${bs.symbolId}`);
      const pip = pipSize(bs.symbol.digits);
      const live = prices.get(bs.symbol.name);
      let spreadPips: string | null = null;
      if (live) {
        const raw = new Prisma.Decimal(live.ask).sub(live.bid);
        const target = c?.targetTotalSpreadPips?.mul(pip);
        const parts = markupSplit(target ? Prisma.Decimal.max(target.sub(raw), 0).div(pip) : c?.spreadMarkup ?? bs.spreadMarkup, bs.symbol.digits);
        spreadPips = raw.add(parts.ask).add(parts.bid).div(pip).toFixed(1);
      }
      const commission = c?.commissionPerLot ?? bs.commissionPerLot;
      return {
        symbol: bs.symbol.name,
        category: bs.symbol.category,
        spreadPips,
        commissionPerLot: commission.gt(0) ? commission.toFixed(2) : null,
        contractSize: bs.symbol.contractSize.toString(),
        hours: hoursSummary(bs.tradingSessions.map((s) => ({ kind: s.kind, dayOfWeek: s.dayOfWeek, openTime: s.openTime, closeTime: s.closeTime })), { category: bs.symbol.category, timeZone: broker.timeZone }),
      };
    }),
  }));
}
