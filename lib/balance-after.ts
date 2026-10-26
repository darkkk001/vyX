import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// The balance right after a ledger row moved it (bo 1.0.96 #9, owner 2026-10-27: a real balance-after on every funds row,
// computed by the server). Never the stored Transaction.balanceAfter: on production 2 accounts carry wrong snapshots
// (concurrent closes before the 2026-09-23 lock fix) and 3 were funded with no ledger row (lib/account-summary.ts header).
// The same rule as the account summary's opening / closing balance instead: today's Account.balance minus every
// balance-moving amount booked AFTER the row, read in one statement. Booked = approval (updatedAt) for a deposit /
// withdrawal, createdAt for every other row; rows booked at the same instant are ordered by id so each gets its own value.
// null for a row that did not move the balance: not COMPLETED (pending / rejected / cancelled), or a credit change
// (CREDIT_IN / CREDIT_OUT move Account.credit, never the balance).

const BOOKED_AT = Prisma.sql`CASE WHEN t.type IN ('DEPOSIT', 'WITHDRAWAL') THEN t."updatedAt" ELSE t."createdAt" END`;
const MOVES = Prisma.sql`t.status = 'COMPLETED' AND t.type NOT IN ('CREDIT_IN', 'CREDIT_OUT')`;

/** Transaction id -> the balance after it (2 dp), for the given ids; ids that did not move the balance are absent. */
export async function bookedBalanceAfter(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await prisma.$queryRaw<{ id: string; after: Prisma.Decimal }[]>`
    WITH tgt AS (
      SELECT t.id, t."accountId", ${BOOKED_AT} AS at FROM "Transaction" t WHERE t.id = ANY(${ids}) AND ${MOVES}
    ), lo AS (
      SELECT "accountId", min(at) AS m FROM tgt GROUP BY 1
    ), mv AS (
      SELECT t.id, t."accountId", t.amount, ${BOOKED_AT} AS at
      FROM "Transaction" t JOIN lo ON lo."accountId" = t."accountId"
      WHERE ${MOVES} AND ${BOOKED_AT} >= lo.m
    ), s AS (
      SELECT id, "accountId",
             COALESCE(SUM(amount) OVER (PARTITION BY "accountId" ORDER BY at DESC, id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS later
      FROM mv
    )
    SELECT s.id, a.balance - s.later AS after
    FROM s JOIN tgt ON tgt.id = s.id JOIN "Account" a ON a.id = s."accountId"`;
  for (const r of rows) out.set(r.id, new Prisma.Decimal(r.after).toFixed(2));
  return out;
}
