import "server-only";
import { Prisma } from "@prisma/client";
import { computePendingCommission } from "@/lib/commission";
import { lockAccountBalance } from "@/lib/account-lock";

type Tx = Prisma.TransactionClient;

// IB commission payout (moved out of app/api/manage/ib-relationships/[id]/route.ts, audit 2026-09-24): shared by the
// direct path (BROKER_ADMIN) and a MANAGER's maker-checker request once a second admin approves it
// (lib/balance-adjustment.ts, kind IB_PAYOUT). The amount is always recomputed here, inside the transaction --
// never a client-supplied or request-time figure.

export class IbPayoutError extends Error {}
/** A payout the partner's state forbids (account not ACTIVE, partner suspended): the routes answer 409. */
export class IbPayoutRefusedError extends IbPayoutError {}

// Step 2 (2026-09-30): the refusals every payout path shares -- the direct PAY, a MANAGER's queued request at approval,
// "pay all" (one PAY per partner) and the explicit release of a suspended partner's frozen pay. Re-checked here, at
// execution, on the locked relationship row, so a state change between filing and approval is always seen.
export async function ibPayoutRefusal(tx: Tx | Prisma.TransactionClient | import("@prisma/client").PrismaClient, ibAccountId: string, opts: { allowSuspended?: boolean } = {}): Promise<string | null> {
  const ib = await tx.account.findUnique({ where: { id: ibAccountId }, select: { status: true, ibSuspendedAt: true } });
  if (!ib) return "partner account not found";
  if (ib.status !== "ACTIVE") return `partner account is ${ib.status.toLowerCase()}: payouts are refused`;
  if (ib.ibSuspendedAt && !opts.allowSuspended) return "partner suspended: pay is frozen";
  return null;
}

export async function executeIbPayout(
  tx: Tx,
  params: { relationshipId: string; brokerId: string; adminId: string; requestId?: string; releaseOwed?: boolean }
) {
  // Step 2: row-lock the relationship BEFORE computing what is owed, so two payouts of the same link at once (two
  // admins, a retry, a double "pay all") serialize here and the second one recomputes after the first committed.
  await tx.$queryRaw`SELECT id FROM "IbRelationship" WHERE id = ${params.relationshipId} FOR UPDATE`;
  const relationship = await tx.ibRelationship.findUnique({ where: { id: params.relationshipId } });
  if (!relationship || relationship.brokerId !== params.brokerId) throw new IbPayoutError("relationship not found");
  const refusal = await ibPayoutRefusal(tx, relationship.ibAccountId, { allowSuspended: params.releaseOwed === true });
  if (refusal) throw new IbPayoutRefusedError(refusal);

  const pending = await computePendingCommission(tx, relationship);
  if (pending.lte(0)) throw new IbPayoutError("no pending commission to pay");

  const balanceBefore = await lockAccountBalance(tx, relationship.ibAccountId); // row lock: lib/account-lock.ts
  const balanceAfter = balanceBefore.add(pending);
  await tx.account.update({ where: { id: relationship.ibAccountId }, data: { balance: balanceAfter } });

  const transaction = await tx.transaction.create({
    data: {
      brokerId: params.brokerId,
      accountId: relationship.ibAccountId,
      type: "COMMISSION",
      status: "COMPLETED",
      amount: pending,
      balanceBefore,
      balanceAfter,
      referenceType: "IbRelationship",
      referenceId: relationship.id,
      reviewedByAdminId: params.adminId,
    },
  });

  // paid up to now: the locked-in amount is consumed, and the next pending counts from this moment (Batch 4)
  const paidAt = new Date();
  const updated = await tx.ibRelationship.update({ where: { id: relationship.id }, data: { lastPayoutAt: paidAt, accruedUnpaid: 0, accruedThrough: paidAt } });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: params.releaseOwed ? "IB_FROZEN_PAY_RELEASED" : "IB_COMMISSION_PAID",
      entityType: "IbRelationship",
      entityId: relationship.id,
      newValue: {
        amount: pending.toString(),
        transactionId: transaction.id,
        balanceBefore: balanceBefore.toString(),
        balanceAfter: balanceAfter.toString(),
        ...(params.requestId ? { requestId: params.requestId } : {}),
      },
    },
  });

  return { transaction, lastPayoutAt: updated.lastPayoutAt! };
}
