import "server-only";
import { prisma } from "@/lib/prisma";
import { publishAccountUpdated } from "@/lib/account-events";
import { marginLevelAfterLeverage } from "@/lib/group-leverage-apply";
import { accountFigures } from "@/lib/room/figures";
import { groupCeiling } from "@/lib/room/plans";
import { tierLeverageCeiling } from "@/lib/room/tier";

// A client's own leverage change from the Trader's Room. Margin is notional / leverage and is recomputed live, so a
// new leverage moves the margin of every open position at once (lib/group-leverage-apply.ts). A change that would put
// the account at or under its stop-out level is refused here; the client closes positions or picks a higher leverage.
// Broker.leverageChangeReview on = the request waits for staff (LeverageChangeRequest); off = applied now.

export class LeverageChangeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export type LeverageCheck = { from: number; to: number; ceiling: number; marginLevel: number | null; marginLevelAfter: number | null; stopOutLevel: number };

export async function checkLeverageChange(accountId: string, to: number): Promise<LeverageCheck> {
  const a = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { id: true, brokerId: true, clientId: true, leverage: true, balance: true, credit: true, status: true, accountMode: true, group: { select: { leverage: true, planMaxLeverage: true, stopOutLevel: true } }, broker: { select: { defaultAccountLeverage: true } } },
  });
  if (a.status !== "ACTIVE") throw new LeverageChangeError("This account is not active.");
  // the plan's ceiling, lifted by the client's tier when the broker gave the tier one (lib/room/tier.ts)
  const planCeiling = a.group ? groupCeiling(a.group) : a.broker.defaultAccountLeverage;
  const tierCeiling = a.clientId ? await tierLeverageCeiling(a.brokerId, a.clientId) : null;
  const ceiling = Math.max(planCeiling, tierCeiling ?? 0);
  if (to === a.leverage) throw new LeverageChangeError(`The account is already on 1:${to}.`);
  if (to > ceiling) throw new LeverageChangeError(`Your plan${tierCeiling && tierCeiling > planCeiling ? " and tier allow" : " allows"} up to 1:${ceiling}.`);
  const figures = await accountFigures(a);
  // no price / fx right now: the stop-out check cannot be made, so a change with open positions waits
  if (!figures.priced && (await prisma.position.count({ where: { accountId, status: "OPEN" } })) > 0) {
    throw new LeverageChangeError("Prices are not available right now. Try again in a minute.", 503);
  }
  const level = figures.marginLevel == null ? null : Number(figures.marginLevel);
  const after = marginLevelAfterLeverage(level, a.leverage, to);
  const stopOut = Number(a.group?.stopOutLevel ?? 50);
  if (after != null && after <= stopOut) {
    throw new LeverageChangeError(`Too low for your open positions: margin level would fall to ${after.toFixed(0)}%.`, 409);
  }
  return { from: a.leverage, to, ceiling, marginLevel: level, marginLevelAfter: after, stopOutLevel: stopOut };
}

/** Applies a checked change; false when the account's leverage moved meanwhile (nothing written). */
export async function applyLeverageChange(p: { brokerId: string; accountId: string; clientId: string; from: number; to: number; actorAdminId: string | null; requestId?: string; marginLevelBefore: number | null; marginLevelAfter: number | null }): Promise<boolean> {
  const done = await prisma.$transaction(async (tx) => {
    const res = await tx.account.updateMany({ where: { id: p.accountId, brokerId: p.brokerId, leverage: p.from }, data: { leverage: p.to } });
    if (res.count === 0) return false;
    await tx.auditLog.create({
      data: {
        brokerId: p.brokerId,
        actorAdminId: p.actorAdminId,
        clientId: p.clientId,
        action: "LEVERAGE_CHANGE",
        entityType: "Account",
        entityId: p.accountId,
        oldValue: { leverage: p.from },
        newValue: { leverage: p.to, source: p.requestId ? "CLIENT_REQUEST" : "CLIENT", ...(p.requestId ? { requestId: p.requestId } : {}), marginLevelBefore: p.marginLevelBefore, marginLevelAfter: p.marginLevelAfter },
      },
    });
    return true;
  });
  if (done) await publishAccountUpdated(p.brokerId, p.accountId, "account");
  return done;
}
