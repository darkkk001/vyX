import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { lockAccountBalances } from "@/lib/account-lock";
import { checkBalanceDebit } from "@/lib/margin";

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

// Internal transfer between two accounts of the SAME client (audit 2026-09-24, money). Shared by the direct path
// (app/api/manage/transfers, BROKER_ADMIN) and a MANAGER's maker-checker request once a second admin approves it
// (lib/balance-adjustment.ts, kind TRANSFER). Both re-run every check here, at execution time.

export class TransferError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

type TransferAccount = { id: string; brokerId: string; accountNumber: string; status: string; accountMode: string; currency: string; clientId: string | null; email: string };

/** One client = the same portal Client when both accounts have one; an admin-created account has no Client yet, so
 *  the e-mail (case-insensitive) decides. */
export function sameClient(a: Pick<TransferAccount, "clientId" | "email">, b: Pick<TransferAccount, "clientId" | "email">): boolean {
  if (a.clientId && b.clientId) return a.clientId === b.clientId;
  return a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
}

export async function validateTransferAccounts(db: Db, params: { brokerId: string; fromAccountId: string; toAccountId: string }): Promise<{ from: TransferAccount; to: TransferAccount }> {
  if (params.fromAccountId === params.toAccountId) throw new TransferError("cannot transfer to the same account");
  const select = { id: true, brokerId: true, accountNumber: true, status: true, accountMode: true, currency: true, clientId: true, email: true } as const;
  const [from, to] = await Promise.all([
    db.account.findUnique({ where: { id: params.fromAccountId }, select }),
    db.account.findUnique({ where: { id: params.toAccountId }, select }),
  ]);
  if (!from || from.brokerId !== params.brokerId || !to || to.brokerId !== params.brokerId) throw new TransferError("account not found", 404);
  if (from.status !== "ACTIVE" || to.status !== "ACTIVE") throw new TransferError("both accounts must be active");
  if (from.accountMode !== to.accountMode) throw new TransferError("cannot transfer between a Demo and a Live account");
  if (from.currency !== to.currency) throw new TransferError(`currency mismatch: ${from.currency} account cannot transfer directly to a ${to.currency} account`);
  // audit 2026-09-24 (money): only the backoffice preview refused this before; the server now does
  if (!sameClient(from, to)) throw new TransferError("transfers are only allowed between accounts of the same client");
  return { from, to };
}

export async function executeTransfer(
  tx: Tx,
  params: { brokerId: string; fromAccountId: string; toAccountId: string; amount: Prisma.Decimal; note: string; adminId: string; requestId?: string }
) {
  if (!params.amount.gt(0)) throw new TransferError("amount must be positive");
  const { from, to } = await validateTransferAccounts(tx, params);
  // both rows locked up front, in id order (lib/account-lock.ts): no lost update, no A->B / B->A deadlock
  const locked = await lockAccountBalances(tx, [params.fromAccountId, params.toAccountId]);
  const fromBalanceBefore = locked.get(params.fromAccountId)!;
  // audit 2026-09-24 (money): not only balance >= amount -- the source's open positions keep their margin
  const debit = await checkBalanceDebit(tx, { accountId: params.fromAccountId, amount: params.amount, balance: fromBalanceBefore });
  if (debit) {
    throw new TransferError(debit.error === "BALANCE_BELOW_ZERO" ? "insufficient balance on the source account" : `transfer refused: ${debit.message}`);
  }
  const fromBalanceAfter = fromBalanceBefore.sub(params.amount);
  await tx.account.update({ where: { id: params.fromAccountId }, data: { balance: fromBalanceAfter } });
  const outTxn = await tx.transaction.create({
    data: {
      brokerId: params.brokerId, accountId: params.fromAccountId, type: "TRANSFER_OUT", status: "COMPLETED",
      amount: params.amount.neg(), balanceBefore: fromBalanceBefore, balanceAfter: fromBalanceAfter,
      note: `Transfer to ${to.accountNumber}: ${params.note}`, createdByAdminId: params.adminId,
    },
  });

  const toBalanceBefore = locked.get(params.toAccountId)!;
  const toBalanceAfter = toBalanceBefore.add(params.amount);
  await tx.account.update({ where: { id: params.toAccountId }, data: { balance: toBalanceAfter } });
  const inTxn = await tx.transaction.create({
    data: {
      brokerId: params.brokerId, accountId: params.toAccountId, type: "TRANSFER_IN", status: "COMPLETED",
      amount: params.amount, balanceBefore: toBalanceBefore, balanceAfter: toBalanceAfter,
      note: `Transfer from ${from.accountNumber}: ${params.note}`, createdByAdminId: params.adminId,
    },
  });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "INTERNAL_TRANSFER",
      entityType: "Account",
      entityId: params.fromAccountId,
      oldValue: { fromBalance: fromBalanceBefore.toString(), toBalance: toBalanceBefore.toString() },
      newValue: { fromAccount: from.accountNumber, toAccount: to.accountNumber, amount: params.amount.toString(), note: params.note, ...(params.requestId ? { requestId: params.requestId } : {}) },
    },
  });

  return { outTxn, inTxn };
}
