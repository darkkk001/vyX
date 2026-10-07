import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { FUNDS_HISTORY_TYPES } from "@/lib/funds-history";

// Step 3b item 8 (owner 2026-10-07): the HISTORY tab of the Funds window. This account's deposits, withdrawals, adjustments, credit
// changes and transfers (the last 200) and the per-type totals over ALL of them. Broker view: the stored sign (a withdrawal and a transfer
// out are negative, a deposit and a transfer in positive; an adjustment and a credit change carry their own sign). Only COMPLETED rows are
// totalled. An adjustment is NOT part of the deposit total (it is its own type), exactly as the dashboard counts it.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true, brokerId: true, currency: true } });
  if (!account || account.brokerId !== session!.brokerId) return NextResponse.json({ error: "not found" }, { status: 404 });
  const where = { accountId: id, type: { in: [...FUNDS_HISTORY_TYPES] } };
  const [rows, sums] = await Promise.all([
    prisma.transaction.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, type: true, status: true, amount: true, balanceAfter: true, note: true, createdAt: true } }),
    prisma.transaction.groupBy({ by: ["type"], where: { ...where, status: "COMPLETED" }, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  return NextResponse.json({
    currency: account.currency,
    rows: rows.map((t) => ({ id: t.id, type: t.type, status: t.status, amount: t.amount.toFixed(2), balanceAfter: t.balanceAfter.toFixed(2), note: t.note ?? "", at: t.createdAt.toISOString() })),
    totals: sums.map((s) => ({ type: s.type, amount: s._sum.amount ? s._sum.amount.toFixed(2) : "0.00", count: s._count._all })),
  });
}
