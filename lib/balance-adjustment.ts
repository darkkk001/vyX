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
