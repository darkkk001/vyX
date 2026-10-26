import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computeAccountMarginSnapshots } from "@/lib/margin";
import { buildEquitySeries } from "@/lib/equity-series";

// The client detail's chart (panel 2 EQ).
//   ?kind=balance (default): the BALANCE line, one point right after every row that moved the balance, then the current
//     balance. bo 1.0.96: computed as today's balance minus every balance-moving amount booked after the row (the account
//     summary's rule, lib/account-summary.ts), no longer the stored Transaction.balanceAfter (wrong on a few old accounts).
//   ?kind=equity (bo 1.0.96 #21, owner 2026-10-27): the EQUITY line, lib/equity-series.ts: recorded snapshots while the
//     account held an open position, balance + credit from the ledger while it held none, then the current equity.
//     `recordedSince` is the account's first snapshot (null = none yet): before the feature went live there are no
//     snapshots, so an open-position stretch before that has no equity points.
/** Capped at 365: this walks every Transaction row in the window, and a multi-year account would be a slow unbounded scan. */
const MAX_DAYS = 365;
const DEFAULT_DAYS = 90;

// booked = approval for a deposit / withdrawal, written time for every other row (lib/account-summary.ts bookedAt)
const BOOKED_AT = Prisma.sql`CASE WHEN t.type IN ('DEPOSIT', 'WITHDRAWAL') THEN t."updatedAt" ELSE t."createdAt" END`;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role, lib/permissions.ts isSupportReader */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  const account = await prisma.account.findUnique({ where: { id }, select: { brokerId: true } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // ?days=7|30|90|<n>. Anything unparseable falls back to the previous fixed
  // 90 days rather than erroring, so an older backoffice that sends no
  // parameter at all keeps its exact current behaviour.
  const sp = new URL(request.url).searchParams;
  const raw = Number(sp.get("days"));
  const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.trunc(raw), MAX_DAYS) : DEFAULT_DAYS;
  const kind = sp.get("kind") === "equity" ? "equity" : "balance";
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // one statement: the account's balance / credit now and the value right after each row booked in the window
  // (suffix sums over every row booked from `since` on, newest first; same-instant rows ordered by id)
  const moves = kind === "balance" ? Prisma.sql`t.type NOT IN ('CREDIT_IN', 'CREDIT_OUT')` : Prisma.sql`t.type <> 'CREDIT'`;
  const rows = await prisma.$queryRaw<{ at: Date; after: Prisma.Decimal }[]>`
    WITH mv AS (
      SELECT t.id, t.amount, ${BOOKED_AT} AS at FROM "Transaction" t
      WHERE t."accountId" = ${id} AND t.status = 'COMPLETED' AND ${moves} AND ${BOOKED_AT} >= ${since}
    )
    SELECT mv.at,
           (SELECT ${kind === "balance" ? Prisma.sql`a.balance` : Prisma.sql`a.balance + a.credit`} FROM "Account" a WHERE a.id = ${id})
             - COALESCE(SUM(mv.amount) OVER (ORDER BY mv.at DESC, mv.id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS after
    FROM mv ORDER BY mv.at ASC, mv.id ASC`;
  const current = await prisma.account.findUniqueOrThrow({ where: { id }, select: { balance: true, credit: true } });

  if (kind === "balance") {
    const points = rows.map((r) => ({ t: r.at.toISOString(), balance: new Prisma.Decimal(r.after).toFixed(2) }));
    points.push({ t: now.toISOString(), balance: current.balance.toFixed(2) });
    // days is echoed back so the caller can label the chart with the window the
    // server actually applied, not the one it asked for (they differ at the cap).
    return NextResponse.json({ kind: "balance", days, points });
  }

  const [snapshots, intervals, first, live] = await Promise.all([
    prisma.accountEquitySnapshot.findMany({ where: { accountId: id, at: { gte: since } }, orderBy: { at: "asc" }, select: { at: true, equity: true } }),
    prisma.position.findMany({ where: { accountId: id, openedAt: { lte: now }, OR: [{ closedAt: null }, { closedAt: { gte: since } }] }, select: { openedAt: true, closedAt: true } }),
    prisma.accountEquitySnapshot.findFirst({ where: { accountId: id }, orderBy: { at: "asc" }, select: { at: true } }),
    computeAccountMarginSnapshots(prisma, brokerId, id),
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
  return NextResponse.json({ kind: "equity", days, recordedSince: first ? first.at.toISOString() : null, points });
}
