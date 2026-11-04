import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { accountEquityCurve, ledgerAfter } from "@/lib/equity-curve";

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

  if (kind === "balance") {
    // the value right after each row booked in the window (lib/equity-curve.ts ledgerAfter: suffix sums from the
    // balance now, never the stored balanceAfter), then the current balance
    const rows = await ledgerAfter(id, since, "balance");
    const current = await prisma.account.findUniqueOrThrow({ where: { id }, select: { balance: true } });
    const points = rows.map((r) => ({ t: r.at.toISOString(), balance: new Prisma.Decimal(r.after).toFixed(2) }));
    points.push({ t: now.toISOString(), balance: current.balance.toFixed(2) });
    // days is echoed back so the caller can label the chart with the window the
    // server actually applied, not the one it asked for (they differ at the cap).
    return NextResponse.json({ kind: "balance", days, points });
  }

  // equity: lib/equity-curve.ts (shared with the Trader's Room analytics since 2026-11-03, logic unchanged)
  const { points, recordedSince } = await accountEquityCurve(id, brokerId, since, now);
  return NextResponse.json({ kind: "equity", days, recordedSince: recordedSince ? recordedSince.toISOString() : null, points });
}
