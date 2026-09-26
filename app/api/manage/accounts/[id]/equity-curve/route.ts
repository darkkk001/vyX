import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// 90-day BALANCE curve for the client detail (panel 2 EQ): the account's
// balanceAfter over time from every Transaction -- deposits / withdrawals /
// adjustments AND the per-trade TRADE_PNL rows, which all carry balanceAfter
// (lib/position-close.ts) -- capped with the current balance. This is a balance
// curve, honestly labelled: a live-floating equity curve would need periodic
// floating-P&L snapshots, which this codebase does not store.
/** Ranges the client detail offers. Capped at 365: this walks every Transaction
 *  row in the window, and a multi-year account would be a slow unbounded scan. */
const MAX_DAYS = 365;
const DEFAULT_DAYS = 90;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role, lib/permissions.ts isSupportReader */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  const account = await prisma.account.findUnique({ where: { id }, select: { brokerId: true, balance: true } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // ?days=7|30|90|<n>. Anything unparseable falls back to the previous fixed
  // 90 days rather than erroring, so an older backoffice that sends no
  // parameter at all keeps its exact current behaviour.
  const raw = Number(new URL(request.url).searchParams.get("days"));
  const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.trunc(raw), MAX_DAYS) : DEFAULT_DAYS;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const txs = await prisma.transaction.findMany({
    where: { accountId: id, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, balanceAfter: true },
  });

  const points = txs.map((t) => ({ t: t.createdAt.toISOString(), balance: t.balanceAfter.toString() }));
  points.push({ t: new Date().toISOString(), balance: account.balance.toString() });

  // days is echoed back so the caller can label the chart with the window the
  // server actually applied, not the one it asked for (they differ at the cap).
  return NextResponse.json({ kind: "balance", days, points });
}
