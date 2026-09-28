import "server-only";
import { prisma } from "@/lib/prisma";
import { computeAccountMarginSnapshots } from "@/lib/margin";

// Phase 2 batch 8 (issues 128 / 184, owner decisions 2026-09-27 + 2026-09-28): a group's leverage edit never cascades by
// itself; "Apply to existing accounts" copies it down explicitly. Margin = notional / leverage, so after the change an
// account's used margin is used * old / new and its margin level is level * new / old. Lowering leverage can push an
// account under stop-out: those accounts are listed and LEFT OUT unless the admin explicitly includes them.

export type LeverageApplyRow = {
  accountId: string;
  accountNumber: string;
  fullName: string;
  leverage: number;
  newLeverage: number;
  marginLevel: number | null; // now; null = no used margin (no open positions, or none priced)
  marginLevelAfter: number | null;
  marginCallLevel: number;
  stopOutLevel: number;
  belowMarginCall: boolean;
  belowStopOut: boolean;
};

export type LeverageApplyPreview = { groupId: string; groupName: string; groupLeverage: number; rows: LeverageApplyRow[] };

/** Pure: the margin level after a leverage change (null stays null: no used margin, nothing to stop out). */
export function marginLevelAfterLeverage(marginLevel: number | null, oldLeverage: number, newLeverage: number): number | null {
  if (marginLevel == null || oldLeverage <= 0 || newLeverage <= 0) return marginLevel;
  return (marginLevel * newLeverage) / oldLeverage;
}

export async function previewGroupLeverage(brokerId: string, groupId: string): Promise<LeverageApplyPreview | null> {
  const group = await prisma.group.findFirst({ where: { id: groupId, brokerId }, select: { id: true, name: true, leverage: true, marginCallLevel: true, stopOutLevel: true } });
  if (!group) return null;
  const accounts = await prisma.account.findMany({
    where: { brokerId, groupId, leverage: { not: group.leverage } },
    select: { id: true, accountNumber: true, fullName: true, leverage: true },
    orderBy: { accountNumber: "asc" },
  });
  const snapshots = accounts.length > 0 ? await computeAccountMarginSnapshots(prisma, brokerId) : [];
  const byId = new Map(snapshots.map((s) => [s.accountId, s]));
  const mc = group.marginCallLevel.toNumber();
  const so = group.stopOutLevel.toNumber();
  return {
    groupId: group.id,
    groupName: group.name,
    groupLeverage: group.leverage,
    rows: accounts.map((a) => {
      const level = byId.get(a.id)?.marginLevel ?? null;
      const after = marginLevelAfterLeverage(level, a.leverage, group.leverage);
      return {
        accountId: a.id,
        accountNumber: a.accountNumber,
        fullName: a.fullName,
        leverage: a.leverage,
        newLeverage: group.leverage,
        marginLevel: level,
        marginLevelAfter: after,
        marginCallLevel: mc,
        stopOutLevel: so,
        belowMarginCall: after != null && after < mc,
        belowStopOut: after != null && after < so,
      };
    }),
  };
}
