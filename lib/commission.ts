import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// Pending IB commission is computed on read from CLOSED Positions on the
// client account, never stored/accrued -- see IbRelationship.lastPayoutAt's
// schema comment. Callers must re-run this inside the same $transaction
// that performs a payout (never trust a client-supplied amount).
export async function computePendingCommission(
  db: Db,
  relationship: {
    clientAccountId: string;
    commissionType: "PER_LOT" | "PERCENTAGE";
    commissionRate: Prisma.Decimal;
    lastPayoutAt: Date | null;
  }
): Promise<Prisma.Decimal> {
  const agg = await db.position.aggregate({
    where: {
      accountId: relationship.clientAccountId,
      status: "CLOSED",
      ...(relationship.lastPayoutAt ? { closedAt: { gt: relationship.lastPayoutAt } } : {}),
    },
    _sum: { volume: true, commission: true },
  });

  if (relationship.commissionType === "PER_LOT") {
    const lots = agg._sum.volume ?? new Prisma.Decimal(0);
    return relationship.commissionRate.mul(lots);
  }

  // PERCENTAGE -- the IB's cut of the broker's own trading-commission
  // revenue on the client's closed trades (Position.commission), a
  // standard IB revenue-share basis. No spec exists to confirm this
  // choice -- flagged in docs/architecture.md's IB log entry.
  const brokerCommissionRevenue = agg._sum.commission ?? new Prisma.Decimal(0);
  return relationship.commissionRate.div(100).mul(brokerCommissionRevenue);
}
