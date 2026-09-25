import "server-only";
import { Prisma } from "@prisma/client";
import { nextPspStatusOnMark, nextPspStatusOnApprove } from "@/lib/psp/adapter";
import { lockAccountBalance } from "@/lib/account-lock";
import { checkBalanceDebit } from "@/lib/margin";

type Tx = Prisma.TransactionClient;

// Extracted out of app/api/manage/funds-requests/[id]/route.ts (Phase 1
// §4, docs/ROADMAP.md's "funds approval maker-checker") so the
// maker-checker decision itself is directly unit-testable without a DB
// -- same "pure check, DB mutation at the call site" split as
// lib/risk.ts's own checks. WITHDRAWAL only: a first APPROVE marks it
// (no balance change yet); a second APPROVE by a *different* admin is
// what actually completes it. DEPOSIT stays single-approval -- only
// withdrawals move money out.
export type FundsApprovalStep =
  | { step: "mark" }
  | { step: "approve"; single: boolean }
  | { step: "error"; error: string };

// Owner decision D5 (2026-09-25): Broker.withdrawalApproval. DUAL (default) = the two-admin flow above. SINGLE = a
// BROKER_ADMIN completes a withdrawal alone (marked or not), audited as a single approval. A MANAGER (even with
// FUNDS_APPROVAL) never completes one alone: in either mode its APPROVE only marks, and a different admin completes.
export function resolveFundsApprovalStep(params: {
  type: "DEPOSIT" | "WITHDRAWAL";
  markedByAdminId: string | null;
  actingAdminId: string;
  actingRole: "BROKER_ADMIN" | "MANAGER";
  withdrawalApproval: "SINGLE" | "DUAL";
}): FundsApprovalStep {
  if (params.type === "DEPOSIT") {
    return { step: "approve", single: false };
  }
  // WITHDRAWAL
  if (params.withdrawalApproval === "SINGLE" && params.actingRole === "BROKER_ADMIN") {
    return { step: "approve", single: true };
  }
  if (!params.markedByAdminId) {
    return { step: "mark" };
  }
  if (params.markedByAdminId === params.actingAdminId) {
    return { step: "error", error: "a different staff member must confirm this withdrawal" };
  }
  return { step: "approve", single: false };
}

/** Thrown inside a transaction when another admin already acted on the same request (status-guarded claim). */
export class FundsRequestRaceError extends Error {
  constructor() {
    super("request already reviewed");
  }
}

export type MarkResult = { transactionId: string; markedByAdminId: string };

// The first APPROVE on a withdrawal -- marks only, no balance change.
export async function markFundsRequestForApproval(
  tx: Tx,
  params: { transactionId: string; brokerId: string; adminId: string }
): Promise<MarkResult> {
  const claimed = await tx.transaction.updateMany({
    // status-guarded (audit 2026-09-24): only a PENDING, unmarked request can be marked
    where: { id: params.transactionId, status: "PENDING", markedByAdminId: null },
    // pspStatus advances alongside the real mark regardless of which
    // adapter created the request -- see lib/psp/adapter.ts's own header
    // comment on why this is adapter-agnostic.
    data: { markedByAdminId: params.adminId, markedAt: new Date(), pspStatus: nextPspStatusOnMark() },
  });
  if (claimed.count === 0) throw new FundsRequestRaceError();
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "FUNDS_REQUEST_MARKED_FOR_APPROVAL",
      entityType: "Transaction",
      entityId: params.transactionId,
      newValue: { markedByAdminId: params.adminId },
    },
  });
  return { transactionId: params.transactionId, markedByAdminId: params.adminId };
}

export async function cancelFundsRequestMark(
  tx: Tx,
  params: { transactionId: string; brokerId: string; previousMarkedByAdminId: string; actorAdminId: string }
): Promise<void> {
  await tx.transaction.update({ where: { id: params.transactionId }, data: { markedByAdminId: null, markedAt: null } });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.actorAdminId,
      action: "FUNDS_REQUEST_MARK_CANCELLED",
      entityType: "Transaction",
      entityId: params.transactionId,
      oldValue: { markedByAdminId: params.previousMarkedByAdminId },
      newValue: { markedByAdminId: null },
    },
  });
}

export async function rejectFundsRequest(
  tx: Tx,
  params: { transactionId: string; brokerId: string; adminId: string; note: string | null }
): Promise<{ id: string; status: string }> {
  // status-guarded (audit 2026-09-24): a reject racing an approval can never flip a COMPLETED payout to REJECTED
  const claimed = await tx.transaction.updateMany({
    where: { id: params.transactionId, status: "PENDING" },
    data: { status: "REJECTED", reviewedByAdminId: params.adminId, markedByAdminId: null, markedAt: null, note: params.note },
  });
  if (claimed.count === 0) throw new FundsRequestRaceError();
  const updated = { id: params.transactionId, status: "REJECTED" };
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "FUNDS_REQUEST_REJECTED",
      entityType: "Transaction",
      entityId: params.transactionId,
      oldValue: { status: "PENDING" },
      newValue: { status: "REJECTED", note: params.note },
    },
  });
  return { id: updated.id, status: updated.status };
}

export type ApproveResult =
  | { ok: true; transactionId: string; balanceAfter: Prisma.Decimal }
  | { ok: false; error: string };

// The step that actually moves money -- a DEPOSIT's only approval, or a
// WITHDRAWAL's second (different-admin) confirm. Re-reads the account's
// CURRENT balance inside the transaction (trading activity between
// request and review can have moved it), so a withdrawal that fit at
// request time might not fit anymore.
export async function approveFundsRequest(
  tx: Tx,
  params: {
    transactionId: string;
    brokerId: string;
    accountId: string;
    amount: Prisma.Decimal;
    adminId: string;
    note: string | null;
    type: "DEPOSIT" | "WITHDRAWAL";
    /** SINGLE = completed by one BROKER_ADMIN under Broker.withdrawalApproval SINGLE (recorded in the audit row) */
    approvalMode?: "SINGLE" | "DUAL";
    markedByAdminId?: string | null;
  }
): Promise<ApproveResult> {
  const balanceBefore = await lockAccountBalance(tx, params.accountId); // row lock: lib/account-lock.ts
  const balanceAfter = balanceBefore.add(params.amount); // amount already signed (negative for withdrawal)

  if (params.type === "WITHDRAWAL") {
    // Audit 2026-09-24 (money): not only balance >= 0 -- a payout must not leave open positions under-margined.
    // Checked on the LOCKED balance (lib/margin.ts checkBalanceDebit).
    const debit = await checkBalanceDebit(tx, { accountId: params.accountId, amount: params.amount.neg(), balance: balanceBefore });
    if (debit) {
      return {
        ok: false,
        error:
          debit.error === "BALANCE_BELOW_ZERO"
            ? "account balance is no longer sufficient for this withdrawal, reject or ask the trader to resubmit"
            : `withdrawal refused: ${debit.message}. Reject it or ask the trader to close positions first`,
      };
    }
  }

  // status-guarded claim (audit 2026-09-24): two admins approving at once -- the second waits on the account lock
  // above, then finds the request no longer PENDING and rolls back; the money moves once.
  const claimed = await tx.transaction.updateMany({
    where: { id: params.transactionId, status: "PENDING" },
    data: {
      status: "COMPLETED",
      balanceBefore,
      balanceAfter,
      reviewedByAdminId: params.adminId,
      note: params.note,
      pspStatus: nextPspStatusOnApprove(params.type),
    },
  });
  if (claimed.count === 0) throw new FundsRequestRaceError();

  await tx.account.update({ where: { id: params.accountId }, data: { balance: balanceAfter } });
  const updated = { id: params.transactionId };

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "FUNDS_REQUEST_APPROVED",
      entityType: "Transaction",
      entityId: params.transactionId,
      oldValue: { status: "PENDING", markedByAdminId: params.markedByAdminId ?? null },
      newValue: {
        status: "COMPLETED",
        balanceBefore: balanceBefore.toString(),
        balanceAfter: balanceAfter.toString(),
        // D5: which rule completed it -- SINGLE = one BROKER_ADMIN alone, DUAL = marked + confirmed by two admins
        ...(params.type === "WITHDRAWAL" ? { approvalMode: params.approvalMode ?? "DUAL" } : {}),
      },
    },
  });

  return { ok: true, transactionId: updated.id, balanceAfter };
}
