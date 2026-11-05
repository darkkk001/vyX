import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockAccountFunds } from "@/lib/account-lock";
import { loadAccountMarginState } from "@/lib/margin";
import {
  FLEXIBLE_LEVERAGE_OFF,
  FLEXIBLE_LEVERAGE_OFF_TEXT,
  LEVERAGE_INVALID,
  LEVERAGE_MARGIN,
  MIN_TRADES_NOT_MET,
  allowedLeverageSteps,
  checkLeverageWithinGroup,
  leverageMarginText,
  minTradesText,
  parseLeverage,
} from "@/lib/leverage";

// B2 (owner 2026-11-06): the trader's own leverage change. Accepted only when the group's flexibleLeverage is on, the
// account has enough CLOSED trades of its own (Broker.flexibleLeverageMinTrades, owner Q2), the value is at or below the
// group's maximum and one of the allowed steps, and (owner Q3) the account stays above its stop-out level with the positions
// it holds. Positions that opened under an HMR window keep their margin leverage (Position.openLeverage), so the check
// measures margin position by position (lib/margin.ts), it does not scale one figure.

export type TradeLeverageState = {
  current: number;
  groupMax: number;
  flexible: boolean;
  tradesDone: number;
  tradesNeeded: number;
  allowedSteps: number[];
};

/** Closed trades of THIS account: client positions that reached CLOSED (staff-entered ADMIN positions, voided and deleted ones do not count). */
export async function closedTradeCount(db: Pick<typeof prisma, "position">, accountId: string): Promise<number> {
  return db.position.count({ where: { accountId, status: "CLOSED", deletedAt: null, originOrder: { source: { not: "ADMIN" } } } });
}

export async function tradeLeverageState(accountId: string): Promise<TradeLeverageState | null> {
  const a = await prisma.account.findUnique({
    where: { id: accountId },
    select: { leverage: true, group: { select: { leverage: true, flexibleLeverage: true } }, broker: { select: { flexibleLeverageMinTrades: true } } },
  });
  if (!a) return null;
  const groupMax = a.group?.leverage ?? a.leverage;
  return {
    current: a.leverage,
    groupMax,
    flexible: a.group?.flexibleLeverage === true,
    tradesDone: await closedTradeCount(prisma, accountId),
    tradesNeeded: a.broker.flexibleLeverageMinTrades,
    allowedSteps: allowedLeverageSteps(groupMax),
  };
}

export type TradeLeverageRefusal = { status: number; code: string; error: string };
export type TradeLeverageResult = { ok: true; from: number; to: number; marginLevelBefore: number | null; marginLevelAfter: number | null } | { ok: false; refusal: TradeLeverageRefusal };

const refuse = (status: number, code: string, error: string): TradeLeverageResult => ({ ok: false, refusal: { status, code, error } });

/** Validates and applies the change in one transaction (the account row is locked, so an order cannot slip in between the margin check and the write). */
export async function changeOwnLeverage(p: { accountId: string; brokerId: string; raw: unknown }): Promise<TradeLeverageResult> {
  const to = parseLeverage(p.raw);
  if (to == null) return refuse(400, LEVERAGE_INVALID, "Pick a leverage from the list.");

  const a = await prisma.account.findUnique({
    where: { id: p.accountId },
    select: { brokerId: true, status: true, leverage: true, group: { select: { leverage: true, flexibleLeverage: true, stopOutLevel: true } }, broker: { select: { flexibleLeverageMinTrades: true } } },
  });
  if (!a || a.brokerId !== p.brokerId || a.status !== "ACTIVE") return refuse(404, "ACCOUNT_NOT_FOUND", "Account not found.");

  // 1. the group allows it
  if (a.group?.flexibleLeverage !== true) return refuse(403, FLEXIBLE_LEVERAGE_OFF, FLEXIBLE_LEVERAGE_OFF_TEXT);
  // 2. enough closed trades of this account
  const needed = a.broker.flexibleLeverageMinTrades;
  const done = await closedTradeCount(prisma, p.accountId);
  if (done < needed) return refuse(403, MIN_TRADES_NOT_MET, minTradesText(done, needed));
  // 3. at or below the group's maximum (B1), and one of the allowed steps
  const groupMax = a.group.leverage;
  const above = checkLeverageWithinGroup(to, groupMax);
  if (above) return refuse(400, above.code, above.error);
  if (!allowedLeverageSteps(groupMax).includes(to)) return refuse(400, LEVERAGE_INVALID, "Pick a leverage from the list.");
  if (to === a.leverage) return refuse(400, LEVERAGE_INVALID, `The account is already on 1:${to}.`);

  const stopOut = a.group.stopOutLevel;
  return prisma.$transaction(async (tx): Promise<TradeLeverageResult> => {
    await lockAccountFunds(tx, p.accountId);
    const before = await loadAccountMarginState(tx, p.accountId, a.leverage, [], p.brokerId);
    const openCount = before?.openPositions ?? 0;
    const after = await loadAccountMarginState(tx, p.accountId, to, [], p.brokerId);
    let levelBefore: number | null = null;
    let levelAfter: number | null = null;
    if (before && before.usedMargin.gt(0)) levelBefore = before.equity.div(before.usedMargin).mul(100).toNumber();
    if (after && after.usedMargin.gt(0)) {
      const lvl = after.equity.div(after.usedMargin).mul(100);
      levelAfter = lvl.toNumber();
      // owner Q3: positions may stay open as long as the margin level stays ABOVE the stop-out level
      if (lvl.lte(stopOut)) return { ok: false, refusal: { status: 409, code: LEVERAGE_MARGIN, error: leverageMarginText(to) } };
    } else if (!after && openCount === 0) {
      // no state because of a missing FX rate cannot happen with nothing open; defensive
    } else if (!after) {
      return { ok: false, refusal: { status: 503, code: LEVERAGE_MARGIN, error: "Prices are not available right now. Try again in a minute." } };
    }
    const res = await tx.account.updateMany({ where: { id: p.accountId, brokerId: p.brokerId, leverage: a.leverage, group: { is: { leverage: { gte: to } } } }, data: { leverage: to } });
    if (res.count === 0) return { ok: false, refusal: { status: 409, code: LEVERAGE_INVALID, error: "The leverage changed meanwhile. Try again." } };
    await tx.auditLog.create({
      data: {
        brokerId: p.brokerId,
        action: "LEVERAGE_CHANGED_BY_CLIENT",
        entityType: "Account",
        entityId: p.accountId,
        oldValue: { leverage: a.leverage } as Prisma.InputJsonValue,
        newValue: { leverage: to, groupMax, tradesDone: done, tradesNeeded: needed, marginLevelBefore: levelBefore, marginLevelAfter: levelAfter } as Prisma.InputJsonValue,
      },
    });
    return { ok: true, from: a.leverage, to, marginLevelBefore: levelBefore, marginLevelAfter: levelAfter };
  });
}

export { FLEXIBLE_LEVERAGE_OFF };
