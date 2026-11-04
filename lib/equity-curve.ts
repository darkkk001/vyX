import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeAccountMarginSnapshots } from "@/lib/margin";
import { buildEquitySeries, type EquityPoint } from "@/lib/equity-series";

// One account's equity line since `since` (lib/equity-series.ts rules): ledger points while flat, recorded snapshots
// while holding, the live equity now. Shared by the backoffice client chart (manage/accounts/[id]/equity-curve) and the
// Trader's Room analytics (moved out of that route unchanged, 2026-11-03).

// a deposit / withdrawal moves the balance when it is completed (updatedAt), every other row when it is written
const BOOKED_AT = Prisma.sql`CASE WHEN t.type IN ('DEPOSIT', 'WITHDRAWAL') THEN t."updatedAt" ELSE t."createdAt" END`;

/** Ledger rows since `since` with the value right after each: balance (credit rows left out) or balance + credit. */
export async function ledgerAfter(accountId: string, since: Date, kind: "balance" | "equity"): Promise<{ at: Date; after: Prisma.Decimal }[]> {
  const moves = kind === "balance" ? Prisma.sql`t.type NOT IN ('CREDIT_IN', 'CREDIT_OUT')` : Prisma.sql`t.type <> 'CREDIT'`;
  return prisma.$queryRaw<{ at: Date; after: Prisma.Decimal }[]>`
    WITH mv AS (
      SELECT t.id, t.amount, ${BOOKED_AT} AS at FROM "Transaction" t
      WHERE t."accountId" = ${accountId} AND t.status = 'COMPLETED' AND ${moves} AND ${BOOKED_AT} >= ${since}
    )
    SELECT mv.at,
           (SELECT ${kind === "balance" ? Prisma.sql`a.balance` : Prisma.sql`a.balance + a.credit`} FROM "Account" a WHERE a.id = ${accountId})
             - COALESCE(SUM(mv.amount) OVER (ORDER BY mv.at DESC, mv.id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS after
    FROM mv ORDER BY mv.at ASC, mv.id ASC`;
}

export async function accountEquityCurve(accountId: string, brokerId: string, since: Date, now = new Date()): Promise<{ points: EquityPoint[]; recordedSince: Date | null }> {
  const [rows, current, snapshots, intervals, first, live] = await Promise.all([
    ledgerAfter(accountId, since, "equity"),
    prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { balance: true, credit: true } }),
    prisma.accountEquitySnapshot.findMany({ where: { accountId, at: { gte: since } }, orderBy: { at: "asc" }, select: { at: true, equity: true } }),
    prisma.position.findMany({ where: { accountId, openedAt: { lte: now }, OR: [{ closedAt: null }, { closedAt: { gte: since } }] }, select: { openedAt: true, closedAt: true } }),
    prisma.accountEquitySnapshot.findFirst({ where: { accountId }, orderBy: { at: "asc" }, select: { at: true } }),
    computeAccountMarginSnapshots(prisma, brokerId, accountId),
  ]);
  // now: the live equity when the account holds positions that could all be priced; with none, balance + credit;
  // with an unpriced one, no current point (a partial floating would draw a wrong last value)
  const snap = live[0];
  const nowEquity = !snap ? current.balance.add(current.credit).toFixed(2) : snap.unpriced === 0 ? new Prisma.Decimal(snap.equity).toFixed(2) : null;
  const points = buildEquitySeries({
    ledger: rows.map((r) => ({ at: r.at, equity: new Prisma.Decimal(r.after).toFixed(2) })),
    snapshots: snapshots.map((s) => ({ at: s.at, equity: s.equity.toFixed(2) })),
    intervals,
    now: nowEquity === null ? null : { at: now, equity: nowEquity },
  });
  return { points, recordedSince: first?.at ?? null };
}
