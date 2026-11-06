import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockAccountBalance } from "@/lib/account-lock";
import { checkBalanceDebit } from "@/lib/margin";
import { createNotification } from "@/lib/notifications";
import { publishTradingEvent } from "@/lib/nats";
import { publishRoomChanged } from "@/lib/room/events";

// Staking (behind Broker.stakingEnabled, off by default). A stake moves money out of an account's balance, so it leaves free
// margin, into the Stake ledger. At the end of the cycle the principal and the return go back to that account as one
// "Staking return" transaction.
//
// A stake keeps the rate and the cycle it was opened with: a later change of the broker's plan is for new stakes only. A
// stake that is running is paid out even if the broker has since switched the feature off, so no money can be stranded.

export class StakeError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

const DAY_MS = 86400e3;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export type StakingPlan = { minAmount: string; cycleDays: number; ratePct: string };
export const planOf = (b: { stakingMinAmount: Prisma.Decimal; stakingCycleDays: number; stakingRatePct: Prisma.Decimal }): StakingPlan => ({
  minAmount: b.stakingMinAmount.toFixed(2),
  cycleDays: b.stakingCycleDays,
  ratePct: b.stakingRatePct.toString(),
});

/** The return of one cycle, rounded down to the cent. */
export function stakeReturn(amount: Prisma.Decimal.Value, ratePct: Prisma.Decimal.Value): Prisma.Decimal {
  return D(amount).mul(ratePct).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
}

export async function openStake(params: { brokerId: string; clientId: string; accountId: string; amount: Prisma.Decimal; now?: Date }) {
  const now = params.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const broker = await tx.broker.findUniqueOrThrow({ where: { id: params.brokerId }, select: { stakingEnabled: true, stakingMinAmount: true, stakingCycleDays: true, stakingRatePct: true } });
    if (!broker.stakingEnabled) throw new StakeError("Staking is not available.", 404);
    const kyc = await tx.clientKycRecord.findUnique({ where: { clientId: params.clientId }, select: { status: true } });
    if (kyc?.status !== "APPROVED") throw new StakeError("Available after verification.", 403);
    const account = await tx.account.findFirst({ where: { id: params.accountId, clientId: params.clientId, brokerId: params.brokerId }, select: { id: true, accountNumber: true, accountMode: true, status: true, currency: true } });
    if (!account) throw new StakeError("Account not found.", 404);
    if (account.accountMode !== "LIVE" || account.status !== "ACTIVE") throw new StakeError("Pick an active live account.");
    if (params.amount.decimalPlaces() > 2 || params.amount.lt(broker.stakingMinAmount)) throw new StakeError(`The minimum is ${broker.stakingMinAmount.toFixed(2)} ${account.currency}.`);

    const balanceBefore = await lockAccountBalance(tx, account.id);
    if (await checkBalanceDebit(tx, { accountId: account.id, amount: params.amount, balance: balanceBefore })) throw new StakeError("This is more than the account's free margin.");
    const balanceAfter = balanceBefore.sub(params.amount);
    await tx.account.update({ where: { id: account.id }, data: { balance: balanceAfter } });
    const out = await tx.transaction.create({
      data: { brokerId: params.brokerId, accountId: account.id, type: "STAKE_OUT", status: "COMPLETED", amount: params.amount.neg(), balanceBefore, balanceAfter, note: "Stake" },
    });
    const stake = await tx.stake.create({
      data: {
        brokerId: params.brokerId, clientId: params.clientId, accountId: account.id, amount: params.amount, currency: account.currency,
        ratePct: broker.stakingRatePct, cycleDays: broker.stakingCycleDays, returnAmount: stakeReturn(params.amount, broker.stakingRatePct),
        startAt: now, endAt: new Date(now.getTime() + broker.stakingCycleDays * DAY_MS), openTransactionId: out.id,
      },
    });
    await tx.auditLog.create({ data: { brokerId: params.brokerId, clientId: params.clientId, action: "STAKE_OPENED", entityType: "Stake", entityId: stake.id, newValue: { accountNumber: account.accountNumber, amount: params.amount.toString(), ratePct: broker.stakingRatePct.toString(), cycleDays: broker.stakingCycleDays } } });
    return { stake, transactionId: out.id };
  });
}

/** Pays every stake whose cycle has ended. Safe to run twice or at once: a stake is claimed before any money moves. */
export async function payDueStakes(db: PrismaClient = prisma, now = new Date(), limit = 200) {
  const due = await db.stake.findMany({ where: { status: "ACTIVE", endAt: { lte: now } }, orderBy: { endAt: "asc" }, take: limit, select: { id: true } });
  let paid = 0, failed = 0;
  for (const { id } of due) {
    try {
      const done = await db.$transaction(async (tx) => {
        const claim = await tx.stake.updateMany({ where: { id, status: "ACTIVE" }, data: { status: "PAID", paidAt: now } });
        if (claim.count === 0) return null;
        const s = await tx.stake.findUniqueOrThrow({ where: { id } });
        const total = s.amount.add(s.returnAmount);
        const balanceBefore = await lockAccountBalance(tx, s.accountId);
        const balanceAfter = balanceBefore.add(total);
        await tx.account.update({ where: { id: s.accountId }, data: { balance: balanceAfter } });
        const t = await tx.transaction.create({
          data: { brokerId: s.brokerId, accountId: s.accountId, type: "STAKING_RETURN", status: "COMPLETED", amount: total, balanceBefore, balanceAfter, note: "Staking return", referenceType: "Stake", referenceId: s.id },
        });
        await tx.stake.update({ where: { id }, data: { payoutTransactionId: t.id } });
        await tx.auditLog.create({ data: { brokerId: s.brokerId, clientId: s.clientId, action: "STAKE_PAID", entityType: "Stake", entityId: s.id, newValue: { amount: s.amount.toString(), returnAmount: s.returnAmount.toString() } } });
        return { s, total, transactionId: t.id };
      });
      if (!done) continue;
      paid++;
      const { s, total, transactionId } = done;
      const title = `Your stake was returned: ${total.toFixed(2)} ${s.currency}`;
      await createNotification(db, { brokerId: s.brokerId, accountId: s.accountId, type: "STAKING_RETURN", title, body: title, entityType: "Stake", entityId: s.id }).catch(() => {});
      await publishTradingEvent("BalanceChanged", { account_id: s.accountId, broker_id: s.brokerId, transaction_id: transactionId }).catch(() => {});
      await publishRoomChanged(s.brokerId, [s.accountId], "funds");
    } catch (err) {
      failed++;
      console.error("[staking] payout failed, retried on the next run", { stakeId: id, err });
    }
  }
  return { due: due.length, paid, failed };
}
