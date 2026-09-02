import "server-only";
import { Prisma } from "@prisma/client";

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
  | { step: "approve" }
  | { step: "error"; error: string };

export function resolveFundsApprovalStep(params: {
  type: "DEPOSIT" | "WITHDRAWAL";
  markedByAdminId: string | null;
  actingAdminId: string;
}): FundsApprovalStep {
  if (params.type === "DEPOSIT") {
    return { step: "approve" };
  }
  // WITHDRAWAL
  if (!params.markedByAdminId) {
    return { step: "mark" };
  }
  if (params.markedByAdminId === params.actingAdminId) {
    return { step: "error", error: "a different staff member must confirm this withdrawal" };
  }
  return { step: "approve" };
}

export type MarkResult = { transactionId: string; markedByAdminId: string };

// The first APPROVE on a withdrawal -- marks only, no balance change.
export async function markFundsRequestForApproval(
  tx: Tx,
  params: { transactionId: string; brokerId: string; adminId: string }
): Promise<MarkResult> {
  await tx.transaction.update({
    where: { id: params.transactionId },
    data: { markedByAdminId: params.adminId, markedAt: new Date() },
  });
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
  const updated = await tx.transaction.update({
    where: { id: params.transactionId },
    data: { status: "REJECTED", reviewedByAdminId: params.adminId, markedByAdminId: null, markedAt: null, note: params.note },
  });
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
  params: { transactionId: string; brokerId: string; accountId: string; amount: Prisma.Decimal; adminId: string; note: string | null }
): Promise<ApproveResult> {
  const account = await tx.account.findUniqueOrThrow({ where: { id: params.accountId } });
  const balanceBefore = account.balance;
  const balanceAfter = balanceBefore.add(params.amount); // amount already signed (negative for withdrawal)

  if (balanceAfter.lt(0)) {
    return { ok: false, error: "account balance is no longer sufficient for this withdrawal -- reject or ask the trader to resubmit" };
  }

  await tx.account.update({ where: { id: params.accountId }, data: { balance: balanceAfter } });

  const updated = await tx.transaction.update({
    where: { id: params.transactionId },
    data: { status: "COMPLETED", balanceBefore, balanceAfter, reviewedByAdminId: params.adminId, note: params.note },
  });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "FUNDS_REQUEST_APPROVED",
      entityType: "Transaction",
      entityId: params.transactionId,
      oldValue: { status: "PENDING" },
      newValue: { status: "COMPLETED", balanceBefore: balanceBefore.toString(), balanceAfter: balanceAfter.toString() },
    },
  });

  return { ok: true, transactionId: updated.id, balanceAfter };
}
