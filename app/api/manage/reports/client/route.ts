import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { toCsv } from "@/lib/csv";

export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const accounts = await prisma.account.findMany({
    where: { brokerId },
    include: { group: { select: { name: true } } },
    orderBy: { accountNumber: "asc" },
  });

  const csv = toCsv(
    accounts.map((a) => ({
      accountNumber: a.accountNumber,
      fullName: a.fullName,
      email: a.email,
      accountType: a.accountType,
      currency: a.currency,
      balance: a.balance.toString(),
      group: a.group?.name ?? "",
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    })),
    [
      { key: "accountNumber", label: "Account" },
      { key: "fullName", label: "Full Name" },
      { key: "email", label: "Email" },
      { key: "accountType", label: "Type" },
      { key: "currency", label: "Currency" },
      { key: "balance", label: "Balance" },
      { key: "group", label: "Group" },
      { key: "status", label: "Status" },
      { key: "createdAt", label: "Created At" },
    ]
  );

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="client-report.csv"' },
  });
}
