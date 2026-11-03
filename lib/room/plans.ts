import "server-only";
import { prisma } from "@/lib/prisma";
import { isLpConnected } from "@/lib/liquidity";

// Trader's Room plans (Standard / Pro / Zero): the broker's client-selectable groups, one card per account plan
// (Group.displayName; several groups may share one, the default one represents it). The internal group name never
// leaves the server. Card figures come from the broker's config on the group (plan* fields); a figure left unset is
// not shown.

export const LEVERAGE_LADDER = [1000, 500, 400, 300, 200, 100, 50, 30, 20, 10, 5, 2, 1];

/** Leverage choices up to `ceiling`, highest first (the ceiling itself is always offered). */
export function leverageOptions(ceiling: number): number[] {
  const list = LEVERAGE_LADDER.filter((l) => l <= ceiling);
  if (!list.includes(ceiling)) list.unshift(ceiling);
  return list.sort((a, b) => b - a);
}

export type RoomPlan = {
  groupId: string;
  name: string;
  spreadFrom: string | null;
  commissionPerLot: string | null;
  minDeposit: string | null;
  maxLeverage: number;
  leverageOptions: number[];
};

export async function roomPlans(brokerId: string, mode: "LIVE" | "DEMO"): Promise<RoomPlan[]> {
  const groups = await prisma.group.findMany({
    where: {
      brokerId,
      isClientSelectable: true,
      category: { notIn: isLpConnected() ? ["COVERAGE"] : ["COVERAGE", "A_BOOK"] },
      modeRestriction: mode === "DEMO" ? { in: ["ANY", "DEMO_ONLY"] } : { in: ["ANY", "LIVE_ONLY"] },
      tradingHaltedAt: null,
    },
    select: { id: true, displayName: true, leverage: true, isDefault: true, planSpreadFrom: true, planCommissionPerLot: true, planMinDeposit: true, planMaxLeverage: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const byPlan = new Map<string, (typeof groups)[number]>();
  for (const g of groups) if (!byPlan.has(g.displayName)) byPlan.set(g.displayName, g);
  return [...byPlan.values()]
    .map((g) => {
      const max = groupCeiling(g);
      return {
        groupId: g.id,
        name: g.displayName,
        spreadFrom: g.planSpreadFrom,
        commissionPerLot: g.planCommissionPerLot?.toFixed(2) ?? null,
        minDeposit: g.planMinDeposit?.toFixed(0) ?? null,
        maxLeverage: max,
        leverageOptions: leverageOptions(max),
      };
    })
    .sort((a, b) => Number(a.minDeposit ?? 0) - Number(b.minDeposit ?? 0));
}

/** The highest leverage a client may pick on this group: its plan ceiling, else the group's own leverage. */
export function groupCeiling(g: { leverage: number; planMaxLeverage: number | null }): number {
  return g.planMaxLeverage && g.planMaxLeverage > 0 ? g.planMaxLeverage : g.leverage;
}
