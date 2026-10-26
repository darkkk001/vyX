import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeAccountMarginSnapshots } from "@/lib/margin";
import { excludeDemoByBrokerRelation } from "@/lib/demo-policy";

// Equity history (bo 1.0.96 #21, owner 2026-10-27): every 5 minutes, one AccountEquitySnapshot row per account that
//   - holds an open position (an account without one has equity = balance + credit, built from the ledger instead),
//   - had a fresh price and an FX rate for EVERY open position (a partial floating would record a wrong equity), and
//   - whose equity (2 dp) differs from its last row (owner: no row when the equity did not change).
// The valuation is the margin pass's own (lib/margin.ts computeAccountMarginSnapshots: SELL at the account's ask, quote ->
// account currency), so the chart shows what the Margin screen showed at that moment. Rows older than 365 days go.

const KEEP_DAYS = 365;
const DAY_MS = 86_400_000;

export type SnapshotCandidate = { accountId: string; equity: string; balance: string; credit: string; floating: string; unpriced: number };

/** Pure: which candidates get a row, given each account's last recorded equity (2 dp strings). */
export function snapshotsToWrite(candidates: SnapshotCandidate[], lastEquity: Map<string, string>) {
  const write: SnapshotCandidate[] = [];
  let skippedUnpriced = 0;
  let unchanged = 0;
  for (const c of candidates) {
    if (c.unpriced > 0) skippedUnpriced++;
    else if (lastEquity.get(c.accountId) === c.equity) unchanged++;
    else write.push(c);
  }
  return { write, skippedUnpriced, unchanged };
}

const d2 = (n: number) => new Prisma.Decimal(n).toFixed(2);

export async function recordEquitySnapshots(now = new Date()) {
  const brokers = await prisma.position.findMany({ where: { status: "OPEN", ...excludeDemoByBrokerRelation() }, select: { brokerId: true }, distinct: ["brokerId"] });
  const candidates: SnapshotCandidate[] = [];
  for (const { brokerId } of brokers) {
    for (const s of await computeAccountMarginSnapshots(prisma, brokerId)) {
      candidates.push({ accountId: s.accountId, equity: d2(s.equity), balance: d2(s.balance), credit: d2(s.credit), floating: d2(s.floatingPnl), unpriced: s.unpriced });
    }
  }
  const ids = candidates.map((c) => c.accountId);
  const last = ids.length === 0 ? [] : await prisma.$queryRaw<{ accountId: string; equity: Prisma.Decimal }[]>`
    SELECT DISTINCT ON ("accountId") "accountId", equity FROM "AccountEquitySnapshot"
    WHERE "accountId" = ANY(${ids}) ORDER BY "accountId", at DESC`;
  const plan = snapshotsToWrite(candidates, new Map(last.map((r) => [r.accountId, new Prisma.Decimal(r.equity).toFixed(2)])));
  if (plan.write.length > 0) {
    await prisma.accountEquitySnapshot.createMany({
      data: plan.write.map((c) => ({ accountId: c.accountId, at: now, equity: c.equity, balance: c.balance, credit: c.credit, floating: c.floating })),
    });
  }
  const pruned = await prisma.accountEquitySnapshot.deleteMany({ where: { at: { lt: new Date(now.getTime() - KEEP_DAYS * DAY_MS) } } });
  return { accounts: candidates.length, written: plan.write.length, unchanged: plan.unchanged, skippedUnpriced: plan.skippedUnpriced, pruned: pruned.count };
}
