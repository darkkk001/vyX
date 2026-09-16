import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// 90-day BALANCE curve for the client detail (panel 2 EQ): the account's
// balanceAfter over time from every Transaction -- deposits / withdrawals /
// adjustments AND the per-trade TRADE_PNL rows, which all carry balanceAfter
// (lib/position-close.ts) -- capped with the current balance. This is a balance
// curve, honestly labelled: a live-floating equity curve would need periodic
// floating-P&L snapshots, which this codebase does not store.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  const account = await prisma.account.findUnique({ where: { id }, select: { brokerId: true, balance: true } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const txs = await prisma.transaction.findMany({
    where: { accountId: id, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, balanceAfter: true },
  });

  const points = txs.map((t) => ({ t: t.createdAt.toISOString(), balance: t.balanceAfter.toString() }));
  points.push({ t: new Date().toISOString(), balance: account.balance.toString() });

  return NextResponse.json({ kind: "balance", points });
}
