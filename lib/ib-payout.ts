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

export async function executeIbPayout(tx: Tx, params: { relationshipId: string; brokerId: string; adminId: string; requestId?: string }) {
  const relationship = await tx.ibRelationship.findUnique({ where: { id: params.relationshipId } });
  if (!relationship || relationship.brokerId !== params.brokerId) throw new IbPayoutError("relationship not found");

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

  const updated = await tx.ibRelationship.update({ where: { id: relationship.id }, data: { lastPayoutAt: new Date() } });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "IB_COMMISSION_PAID",
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
