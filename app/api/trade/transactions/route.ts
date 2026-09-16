import { NextRequest, NextResponse } from "next/server";
import { TransactionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// The account's balance ledger for the terminal's "Balance history" tab:
// deposits, withdrawals, credits, manual adjustments, and negative-balance
// protection. Trade P&L / commission / swap belong to the trade history
// (app/api/trade/history), so they're excluded here. Account-scoped by the
// session, newest first. The ADJUSTMENT-as-Credit/Debit display (by amount
// sign) is done client-side, same as the backoffice ledger.
const BALANCE_TYPES: TransactionType[] = [
  TransactionType.DEPOSIT,
  TransactionType.WITHDRAWAL,
  TransactionType.CREDIT,
  TransactionType.ADJUSTMENT,
  TransactionType.NEGATIVE_BALANCE_PROTECTION,
];

export async function GET(_request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rows = await prisma.transaction.findMany({
    where: { accountId: session.accountId, type: { in: BALANCE_TYPES } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, type: true, amount: true, note: true, status: true, createdAt: true },
  });

  return NextResponse.json(
    rows.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount.toString(),
      note: t.note ?? "",
      status: t.status,
      createdAt: t.createdAt.toISOString(),
    }))
  );
}
