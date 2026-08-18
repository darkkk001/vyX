import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { toCsv } from "@/lib/csv";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

  const transactions = await prisma.transaction.findMany({
    where: { brokerId, createdAt: { gte: thirtyDaysAgo } },
    include: { account: { select: { accountNumber: true } } },
    orderBy: { createdAt: "desc" },
  });

  const csv = toCsv(
    transactions.map((t) => ({
      createdAt: t.createdAt.toISOString(),
      type: t.type,
      status: t.status,
      account: t.account.accountNumber,
      amount: t.amount.toString(),
      note: t.note ?? "",
    })),
    [
      { key: "createdAt", label: "Date" },
      { key: "type", label: "Type" },
      { key: "status", label: "Status" },
      { key: "account", label: "Account" },
      { key: "amount", label: "Amount" },
      { key: "note", label: "Note" },
    ]
  );

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="financial-report.csv"' },
  });
}
