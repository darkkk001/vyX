import "server-only";
import { Prisma } from "@prisma/client";
import { lockAccountBalance } from "@/lib/account-lock";
import { checkBalanceDebit } from "@/lib/margin";
import { executeTransfer, TransferError, validateTransferAccounts } from "@/lib/transfer";
import { executeIbPayout, IbPayoutError } from "@/lib/ib-payout";
import { computePendingCommission } from "@/lib/commission";

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
  const balanceBefore = await lockAccountBalance(tx, params.accountId); // row lock: lib/account-lock.ts
  const balanceAfter = balanceBefore.add(params.amount);

  if (params.amount.lt(0)) {
    // audit 2026-09-24 (money): a debit never takes the balance below 0 or open positions below their margin
    const debit = await checkBalanceDebit(tx, { accountId: params.accountId, amount: params.amount.neg(), balance: balanceBefore });
    if (debit) throw new BalanceAdjustmentError(`debit refused: ${debit.message}`);
  }

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
// Audit 2026-09-24 (money): the same maker-checker queue now also holds a MANAGER's internal TRANSFER (accountId =
// source, toAccountId = target) and IB_PAYOUT (accountId = the IB account, ibRelationshipId); a different admin with
// the finance permission approves each. The request carries no money until then, and every check runs again at
// approval (execution time), not only here.
export async function requestBalanceAdjustment(
  tx: Tx,
  params: {
    brokerId: string;
    accountId: string;
    amount: Prisma.Decimal;
    note: string;
    adminId: string;
    kind?: "ADJUSTMENT" | "TRANSFER" | "IB_PAYOUT";
    toAccountId?: string;
    ibRelationshipId?: string;
  }
) {
  const kind = params.kind ?? "ADJUSTMENT";
  const account = await tx.account.findUnique({ where: { id: params.accountId } });
  if (!account || account.brokerId !== params.brokerId) throw new BalanceAdjustmentError("account not found");
  if (kind === "TRANSFER") {
    if (!params.toAccountId) throw new BalanceAdjustmentError("a transfer needs a target account");
    await validateTransferAccounts(tx, { brokerId: params.brokerId, fromAccountId: params.accountId, toAccountId: params.toAccountId }).catch((e) => {
      throw e instanceof TransferError ? new BalanceAdjustmentError(e.message) : e;
    });
  }
  if (kind === "IB_PAYOUT") {
    const rel = params.ibRelationshipId ? await tx.ibRelationship.findUnique({ where: { id: params.ibRelationshipId } }) : null;
    if (!rel || rel.brokerId !== params.brokerId || rel.ibAccountId !== params.accountId) throw new BalanceAdjustmentError("relationship not found");
    const open = await tx.balanceAdjustmentRequest.findFirst({ where: { ibRelationshipId: rel.id, status: "PENDING" }, select: { id: true } });
    if (open) throw new BalanceAdjustmentError("a payout for this partner is already waiting for approval");
  }
  // early feedback on money going out; approval re-checks on the locked balance
  const outgoing = kind === "TRANSFER" ? params.amount : kind === "ADJUSTMENT" && params.amount.lt(0) ? params.amount.neg() : null;
  if (outgoing) {
    const debit = await checkBalanceDebit(tx, { accountId: params.accountId, amount: outgoing });
    if (debit) throw new BalanceAdjustmentError(`${kind === "TRANSFER" ? "transfer" : "debit"} refused: ${debit.message}`);
  }

  const request = await tx.balanceAdjustmentRequest.create({
    data: {
      brokerId: params.brokerId,
      accountId: params.accountId,
      amount: params.amount,
      note: params.note,
      requestedByAdminId: params.adminId,
      kind,
      toAccountId: kind === "TRANSFER" ? params.toAccountId! : null,
      ibRelationshipId: kind === "IB_PAYOUT" ? params.ibRelationshipId! : null,
    },
  });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: kind === "TRANSFER" ? "TRANSFER_REQUESTED" : kind === "IB_PAYOUT" ? "IB_PAYOUT_REQUESTED" : "BALANCE_ADJUSTMENT_REQUESTED",
      entityType: "Account",
      entityId: params.accountId,
      newValue: { requestId: request.id, kind, amount: params.amount.toString(), note: params.note, toAccountId: request.toAccountId, ibRelationshipId: request.ibRelationshipId },
    },
  });
  return request;
}

/** For the IB route: what a payout request would carry (the amount is recomputed again at approval). */
export async function pendingIbCommission(tx: Tx, relationshipId: string) {
  const rel = await tx.ibRelationship.findUniqueOrThrow({ where: { id: relationshipId } });
  return computePendingCommission(tx, rel);
}

export type ApproveBalanceAdjustmentResult =
  | { ok: true; requestId: string; transactionId: string; balanceAfter: Prisma.Decimal; accountId: string; affectedAccountIds: string[] }
  | { ok: false; error: string };

export async function approveBalanceAdjustmentRequest(
  tx: Tx,
  params: { requestId: string; brokerId: string; adminId: string; reviewNote: string | null }
): Promise<ApproveBalanceAdjustmentResult> {
  const request = await tx.balanceAdjustmentRequest.findUnique({ where: { id: params.requestId } });
  if (!request || request.brokerId !== params.brokerId) return { ok: false, error: "request not found" };
  if (request.status !== "PENDING") return { ok: false, error: "request already reviewed" };
  if (request.requestedByAdminId === params.adminId) return { ok: false, error: "a different staff member must approve this request" };

  // Status-guarded claim FIRST (audit 2026-09-24, APR race): two admins approving at once -- the second blocks on
  // this row until the first commits, then matches nothing and stops; the money moves once. Anything that fails
  // after the claim throws, so the claim rolls back with it (never APPROVED without its effect).
  const claimed = await tx.balanceAdjustmentRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "APPROVED", reviewedByAdminId: params.adminId, reviewedAt: new Date(), reviewNote: params.reviewNote },
  });
  if (claimed.count === 0) throw new BalanceRequestRaceError();

  let transactionId: string;
  let balanceAfter: Prisma.Decimal;
  let affectedAccountIds: string[];
  try {
    if (request.kind === "TRANSFER") {
      const t = await executeTransfer(tx, {
        brokerId: params.brokerId, fromAccountId: request.accountId, toAccountId: request.toAccountId!, amount: request.amount,
        note: request.note, adminId: params.adminId, requestId: request.id,
      });
      transactionId = t.outTxn.id;
      balanceAfter = t.outTxn.balanceAfter!;
      affectedAccountIds = [request.accountId, request.toAccountId!];
    } else if (request.kind === "IB_PAYOUT") {
      const p = await executeIbPayout(tx, { relationshipId: request.ibRelationshipId!, brokerId: params.brokerId, adminId: params.adminId, requestId: request.id });
      transactionId = p.transaction.id;
      balanceAfter = p.transaction.balanceAfter!;
      affectedAccountIds = [request.accountId];
    } else {
      const a = await applyBalanceAdjustment(tx, { accountId: request.accountId, brokerId: params.brokerId, amount: request.amount, note: request.note, adminId: params.adminId });
      transactionId = a.transactionId;
      balanceAfter = a.balanceAfter;
      affectedAccountIds = [request.accountId];
    }
  } catch (e) {
    if (e instanceof TransferError || e instanceof IbPayoutError) throw new BalanceAdjustmentError(e.message);
    throw e;
  }

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: request.kind === "TRANSFER" ? "TRANSFER_APPROVED" : request.kind === "IB_PAYOUT" ? "IB_PAYOUT_APPROVED" : "BALANCE_ADJUSTMENT_APPROVED",
      entityType: "Account",
      entityId: request.accountId,
      newValue: { requestId: request.id, kind: request.kind, transactionId },
    },
  });

  return { ok: true, requestId: request.id, transactionId, balanceAfter, accountId: request.accountId, affectedAccountIds };
}

/** Thrown inside the approve/reject transaction when another admin already reviewed the request. */
export class BalanceRequestRaceError extends Error {
  constructor() {
    super("request already reviewed");
  }
}

export async function rejectBalanceAdjustmentRequest(
  tx: Tx,
  params: { requestId: string; brokerId: string; adminId: string; reviewNote: string | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = await tx.balanceAdjustmentRequest.findUnique({ where: { id: params.requestId } });
  if (!request || request.brokerId !== params.brokerId) return { ok: false, error: "request not found" };
  if (request.status !== "PENDING") return { ok: false, error: "request already reviewed" };

  // status-guarded: a reject racing an approval can never flip an applied request to REJECTED
  const claimed = await tx.balanceAdjustmentRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "REJECTED", reviewedByAdminId: params.adminId, reviewedAt: new Date(), reviewNote: params.reviewNote },
  });
  if (claimed.count === 0) return { ok: false, error: "request already reviewed" };
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "BALANCE_ADJUSTMENT_REJECTED",
      entityType: "Account",
      entityId: request.accountId,
      newValue: { requestId: request.id, kind: request.kind, reviewNote: params.reviewNote },
    },
  });
  return { ok: true };
}
