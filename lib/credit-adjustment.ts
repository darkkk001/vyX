import "server-only";
import { Prisma } from "@prisma/client";
import { lockAccountFunds } from "@/lib/account-lock";
import { loadAccountMarginState } from "@/lib/margin";

type Tx = Prisma.TransactionClient;

// Credit ($) add / remove by staff (2026-09-28, owner decisions). Credit is the broker's non-withdrawable bonus: it
// counts toward equity (lib/margin.ts, credit Model A) but can never be withdrawn (checkBalanceDebit floors the
// BALANCE). A change never moves the balance. Same maker-checker as a balance adjustment: a BROKER_ADMIN applies it at
// once, a MANAGER files a BalanceAdjustmentRequest (kind CREDIT) that a different admin approves
// (lib/balance-adjustment.ts approveBalanceAdjustmentRequest). Ledger: a CREDIT_IN / CREDIT_OUT Transaction whose
// amount is the change to credit; audit CREDIT_ADDED / CREDIT_REMOVED with credit before and after.

export class CreditAdjustmentError extends Error {}

/** Pure: a non-zero amount and a reason. */
export function validateCreditAdjustment(params: { amount: Prisma.Decimal; note: string }): string | null {
  if (params.amount.isZero()) return "amount must not be zero";
  if (!params.note.trim()) return "a reason is required for a credit change";
  return null;
}

export type CreditRemovalRejection = { error: "CREDIT_BELOW_ZERO" | "INSUFFICIENT_FREE_MARGIN" | "NO_CONVERSION_RATE"; message: string };

/**
 * Pure (owner decision 1): removing credit is refused when it would take credit below 0, or -- with positions open --
 * the margin level to or below the group's margin-call level (the same line a balance debit may not cross).
 */
export function evaluateCreditRemoval(params: {
  creditAfter: Prisma.Decimal;
  equityAfter: Prisma.Decimal;
  usedMargin: Prisma.Decimal;
  marginCallLevel: Prisma.Decimal;
}): CreditRemovalRejection | null {
  if (params.creditAfter.lt(0)) {
    return { error: "CREDIT_BELOW_ZERO", message: `credit would go below 0 (${params.creditAfter.toFixed(2)})` };
  }
  if (params.usedMargin.isZero()) return null;
  const levelAfter = params.equityAfter.div(params.usedMargin).mul(100);
  if (levelAfter.lte(params.marginCallLevel)) {
    return {
      error: "INSUFFICIENT_FREE_MARGIN",
      message: `open positions need it: the margin level would fall to ${levelAfter.toFixed(0)}% (margin call ${params.marginCallLevel.toFixed(0)}%)`,
    };
  }
  return null;
}

/** The removal check on the locked credit (also used for a MANAGER's request, as early feedback). */
export async function checkCreditRemoval(
  tx: Tx | Prisma.TransactionClient,
  params: { accountId: string; amount: Prisma.Decimal; credit?: Prisma.Decimal }
): Promise<CreditRemovalRejection | null> {
  const acc = await tx.account.findUniqueOrThrow({ where: { id: params.accountId }, select: { leverage: true, credit: true, group: { select: { marginCallLevel: true } } } });
  const credit = params.credit ?? acc.credit;
  const creditAfter = credit.add(params.amount); // amount is negative for a removal
  const state = await loadAccountMarginState(tx, params.accountId, acc.leverage);
  if (!state) return { error: "NO_CONVERSION_RATE", message: "an open position cannot be valued in the account currency right now, try again later" };
  // equity was computed from the stored credit; move it to the locked value, then by the change
  const equityAfter = state.equity.add(credit.sub(acc.credit)).add(params.amount);
  return evaluateCreditRemoval({ creditAfter, equityAfter, usedMargin: state.usedMargin, marginCallLevel: acc.group?.marginCallLevel ?? new Prisma.Decimal(100) });
}

export async function applyCreditAdjustment(
  tx: Tx,
  params: { accountId: string; brokerId: string; amount: Prisma.Decimal; note: string; adminId: string; requestId?: string }
): Promise<{ transactionId: string; creditBefore: Prisma.Decimal; creditAfter: Prisma.Decimal }> {
  const { balance, credit: creditBefore } = await lockAccountFunds(tx, params.accountId); // row lock: lib/account-lock.ts
  const creditAfter = creditBefore.add(params.amount);
  if (params.amount.lt(0)) {
    const refused = await checkCreditRemoval(tx, { accountId: params.accountId, amount: params.amount, credit: creditBefore });
    if (refused) throw new CreditAdjustmentError(`credit removal refused: ${refused.message}`);
  }

  await tx.account.update({ where: { id: params.accountId }, data: { credit: creditAfter } });
  const transaction = await tx.transaction.create({
    data: {
      brokerId: params.brokerId,
      accountId: params.accountId,
      type: params.amount.gt(0) ? "CREDIT_IN" : "CREDIT_OUT",
      status: "COMPLETED",
      amount: params.amount,
      // a credit change never moves the balance
      balanceBefore: balance,
      balanceAfter: balance,
      note: params.note,
      createdByAdminId: params.adminId,
    },
  });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: params.amount.gt(0) ? "CREDIT_ADDED" : "CREDIT_REMOVED",
      entityType: "Account",
      entityId: params.accountId,
      oldValue: { credit: creditBefore.toString() },
      newValue: { credit: creditAfter.toString(), amount: params.amount.toString(), note: params.note, transactionId: transaction.id, ...(params.requestId ? { requestId: params.requestId } : {}) },
    },
  });
  return { transactionId: transaction.id, creditBefore, creditAfter };
}
