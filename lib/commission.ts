import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

type Relationship = {
  clientAccountId: string;
  ibAccountId?: string;
  // Step 2: the partner's suspension moment (Account.ibSuspendedAt). undefined = look it up from ibAccountId.
  frozenAt?: Date | null;
  commissionType: "PER_LOT" | "PERCENTAGE";
  commissionRate: Prisma.Decimal;
  lastPayoutAt: Date | null;
  accruedUnpaid?: Prisma.Decimal | null;
  accruedThrough?: Date | null;
};

// Commission on the client's CLOSED trades after `since` (and, for a suspended partner, up to `until`), at the
// relationship's CURRENT rate/type.
async function commissionSince(db: Db, relationship: Relationship, since: Date | null, until: Date | null = null): Promise<Prisma.Decimal> {
  const closedAt: Prisma.DateTimeNullableFilter = {};
  if (since) closedAt.gt = since;
  if (until) closedAt.lte = until;
  const where = {
    accountId: relationship.clientAccountId,
    status: "CLOSED" as const,
    ...(since || until ? { closedAt } : {}),
  };
  const agg = await db.position.aggregate({ where, _sum: { commission: true } });

  if (relationship.commissionType === "PER_LOT") {
    // lots traded = the cumulative closed lots; Position.volume of a closed row is only the last remaining piece, so it
    // is used only for rows closed before closedVolume existed (hotfix 2026-10-12)
    const [withClosed, legacy] = await Promise.all([
      db.position.aggregate({ where: { ...where, closedVolume: { not: null } }, _sum: { closedVolume: true } }),
      db.position.aggregate({ where: { ...where, closedVolume: null }, _sum: { volume: true } }),
    ]);
    const lots = (withClosed._sum.closedVolume ?? new Prisma.Decimal(0)).add(legacy._sum.volume ?? new Prisma.Decimal(0));
    return relationship.commissionRate.mul(lots);
  }

  // PERCENTAGE -- the IB's cut of the broker's own trading-commission
  // revenue on the client's closed trades (Position.commission), a
  // standard IB revenue-share basis. No spec exists to confirm this
  // choice -- flagged in docs/architecture.md's IB log entry.
  const brokerCommissionRevenue = agg._sum.commission ?? new Prisma.Decimal(0);
  return relationship.commissionRate.div(100).mul(brokerCommissionRevenue);
}

// Pending IB commission. Owner decision 2026-09-25 (audit Batch 4): commission is fixed at each trade's close, so a
// rate edit never re-prices trades already closed. What was locked in at earlier rates (accruedUnpaid, up to
// accruedThrough) plus trades closed since then at the current rate. Callers must re-run this inside the same
// $transaction that performs a payout (never trust a client-supplied amount).
//
// Step 2 (owner 2026-09-30): while the partner is suspended (Account.ibSuspendedAt) nothing new accrues -- only trades
// closed up to the suspension moment count. Owed pay is kept (frozen), never zeroed. On resume the accrual clock
// restarts at the resume moment (app/api/manage/ib-partners/[id]/resume), so trades closed while suspended never count.
export async function computePendingCommission(db: Db, relationship: Relationship): Promise<Prisma.Decimal> {
  const locked = relationship.accruedUnpaid ?? new Prisma.Decimal(0);
  const since = relationship.accruedThrough ?? relationship.lastPayoutAt;
  const frozenAt =
    relationship.frozenAt !== undefined
      ? relationship.frozenAt
      : relationship.ibAccountId
        ? ((await db.account.findUnique({ where: { id: relationship.ibAccountId }, select: { ibSuspendedAt: true } }))?.ibSuspendedAt ?? null)
        : null;
  if (frozenAt) {
    if (since && since >= frozenAt) return locked;
    return locked.add(await commissionSince(db, relationship, since, frozenAt));
  }
  return locked.add(await commissionSince(db, relationship, since));
}

/** Before a rate/type change: lock in everything closed so far at the OLD rate (returned for the audit row). */
export async function lockAccruedCommission(db: Db, relationship: Relationship & { id: string }, at = new Date()): Promise<Prisma.Decimal> {
  const pending = await computePendingCommission(db, relationship);
  await db.ibRelationship.update({ where: { id: relationship.id }, data: { accruedUnpaid: pending, accruedThrough: at } });
  return pending;
}
