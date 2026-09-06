import "server-only";
import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// Extracted out of app/api/manage/accounts/[id]/adjust-balance/route.ts
// (Phase 1 §4, docs/ROADMAP.md's "balance adjustment") for direct
// testability -- same "pure validation at the call site, DB mutation
// here" split as every other extracted lib in this app. A direct
// balance correction (no underlying trade) -- first real usage of
// TransactionType.ADJUSTMENT and the "BALANCE_ADJUSTMENT" AuditLog
// action, both existed as unimplemented placeholders before this.

// Pure -- the route's own "amount must not be zero"/"note is required"
// checks, extracted so they're covered without a DB. A zero amount is
// rejected because it would create a no-op ledger row that looks like a
// real adjustment happened; a missing note is rejected because an
// unexplained balance correction is exactly the kind of thing a dispute
// needs a reason on record for.
export function validateBalanceAdjustment(params: { amount: Prisma.Decimal; note: string }): string | null {
  if (params.amount.isZero()) {
    return "amount must not be zero";
  }
  if (!params.note.trim()) {
    return "note is required for a balance adjustment";
  }
  return null;
}

// 2026-09-06 Section D audit fix -- same maker-checker gate
// lib/position-actions.ts's positionActionNeedsApproval already applies
// to Reverse/Void/Delete: a MANAGER (even one holding the delegated
// ACCOUNT_FINANCE permission) files a request a *different* admin must
// approve before the balance actually moves; BROKER_ADMIN is trusted to
// execute directly, same as it already does for position actions. Before
// this, a direct balance correction -- real money moving with no
// underlying trade -- was the one balance-changing action in this app
// with no second admin in the loop at all.
export function balanceAdjustmentNeedsApproval(role: "MANAGER" | "BROKER_ADMIN"): boolean {
  return role === "MANAGER";
}

export class BalanceAdjustmentError extends Error {}

export async function applyBalanceAdjustment(
  tx: Tx,
  params: { accountId: string; brokerId: string; amount: Prisma.Decimal; note: string; adminId: string }
): Promise<{ transactionId: string; balanceAfter: Prisma.Decimal }> {
  const fresh = await tx.account.findUniqueOrThrow({ where: { id: params.accountId } });
  const balanceBefore = fresh.balance;
  const balanceAfter = balanceBefore.add(params.amount);

  await tx.account.update({ where: { id: params.accountId }, data: { balance: balanceAfter } });

  const transaction = await tx.transaction.create({
    data: {
      brokerId: params.brokerId,
      accountId: params.accountId,
      type: "ADJUSTMENT",
      status: "COMPLETED",
      amount: params.amount,
      balanceBefore,
      balanceAfter,
      note: params.note,
      createdByAdminId: params.adminId,
    },
  });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "BALANCE_ADJUSTMENT",
      entityType: "Account",
      entityId: params.accountId,
      oldValue: { balance: balanceBefore.toString() },
      newValue: { balance: balanceAfter.toString(), amount: params.amount.toString(), note: params.note },
    },
  });

  return { transactionId: transaction.id, balanceAfter };
}

// ---------- MANAGER maker-checker: request / approve / reject ----------
// Same shape as lib/position-actions.ts's requestPositionAction/
// approvePositionActionRequest/rejectPositionActionRequest -- a PENDING
// request has zero effect on the account's balance until a different
// admin approves it.
export async function requestBalanceAdjustment(
  tx: Tx,
  params: { brokerId: string; accountId: string; amount: Prisma.Decimal; note: string; adminId: string }
) {
  const account = await tx.account.findUnique({ where: { id: params.accountId } });
  if (!account || account.brokerId !== params.brokerId) throw new BalanceAdjustmentError("account not found");

  const request = await tx.balanceAdjustmentRequest.create({
    data: {
      brokerId: params.brokerId,
      accountId: params.accountId,
      amount: params.amount,
      note: params.note,
      requestedByAdminId: params.adminId,
    },
  });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "BALANCE_ADJUSTMENT_REQUESTED",
      entityType: "Account",
      entityId: params.accountId,
      newValue: { requestId: request.id, amount: params.amount.toString(), note: params.note },
    },
  });
  return request;
}

export type ApproveBalanceAdjustmentResult =
  | { ok: true; requestId: string; transactionId: string; balanceAfter: Prisma.Decimal; accountId: string }
  | { ok: false; error: string };

export async function approveBalanceAdjustmentRequest(
  tx: Tx,
  params: { requestId: string; brokerId: string; adminId: string; reviewNote: string | null }
): Promise<ApproveBalanceAdjustmentResult> {
  const request = await tx.balanceAdjustmentRequest.findUnique({ where: { id: params.requestId } });
  if (!request || request.brokerId !== params.brokerId) return { ok: false, error: "request not found" };
  if (request.status !== "PENDING") return { ok: false, error: "request already reviewed" };
  if (request.requestedByAdminId === params.adminId) return { ok: false, error: "a different staff member must approve this request" };

  const applied = await applyBalanceAdjustment(tx, {
    accountId: request.accountId,
    brokerId: params.brokerId,
    amount: request.amount,
    note: request.note,
    adminId: params.adminId,
  });

  await tx.balanceAdjustmentRequest.update({
    where: { id: request.id },
    data: { status: "APPROVED", reviewedByAdminId: params.adminId, reviewedAt: new Date(), reviewNote: params.reviewNote },
  });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "BALANCE_ADJUSTMENT_APPROVED",
      entityType: "Account",
      entityId: request.accountId,
      newValue: { requestId: request.id, transactionId: applied.transactionId },
    },
  });

  return { ok: true, requestId: request.id, transactionId: applied.transactionId, balanceAfter: applied.balanceAfter, accountId: request.accountId };
}

export async function rejectBalanceAdjustmentRequest(
  tx: Tx,
  params: { requestId: string; brokerId: string; adminId: string; reviewNote: string | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = await tx.balanceAdjustmentRequest.findUnique({ where: { id: params.requestId } });
  if (!request || request.brokerId !== params.brokerId) return { ok: false, error: "request not found" };
  if (request.status !== "PENDING") return { ok: false, error: "request already reviewed" };

  await tx.balanceAdjustmentRequest.update({
    where: { id: request.id },
    data: { status: "REJECTED", reviewedByAdminId: params.adminId, reviewedAt: new Date(), reviewNote: params.reviewNote },
  });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "BALANCE_ADJUSTMENT_REJECTED",
      entityType: "Account",
      entityId: request.accountId,
      newValue: { requestId: request.id, reviewNote: params.reviewNote },
    },
  });
  return { ok: true };
}
