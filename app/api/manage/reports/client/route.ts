import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notCoverageAccount } from "@/lib/client-accounts";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { formatCsvNumber } from "@/lib/format";

export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  // owner 2026-10-05: internal (test / staff) accounts are not clients of the broker
  const cov = (await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { coverageAccountId: true } })).coverageAccountId;   // the hedge account is not client money (lib/client-accounts.ts)
  // 2026-11-09: nor is the broker's own hedge account
  const accounts = await prisma.account.findMany({
    where: { brokerId, isInternal: false, ...notCoverageAccount(cov) },
    include: { group: { select: { name: true } } },
    orderBy: { accountNumber: "asc" },
  });

  const csv = toCsv(
    accounts.map((a) => ({
      accountNumber: a.accountNumber,
      fullName: a.fullName,
      email: a.email,
      accountMode: a.accountMode,
      currency: a.currency,
      balance: formatCsvNumber(a.balance.toString()),
      // owner 2026-11-10: the credit (bonus) beside the balance, never added to it
      credit: formatCsvNumber(a.credit.toString()),
      group: a.group?.name ?? "",
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    })),
    [
      { key: "accountNumber", label: "Account" },
      { key: "fullName", label: "Full Name" },
      { key: "email", label: "Email" },
      { key: "accountMode", label: "Mode" },
      { key: "currency", label: "Currency" },
      { key: "balance", label: "Balance" },
      { key: "credit", label: "Credit" },
      { key: "group", label: "Group" },
      { key: "status", label: "Status" },
      { key: "createdAt", label: "Created At" },
    ]
  );

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="client-report.csv"' },
  });
}
