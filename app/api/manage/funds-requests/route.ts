import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

// BROKER_ADMIN by default -- same finance carve-out as balance
// adjustment/leverage edits (AdminRole.MANAGER's own schema comment: "not
// KYC/finance") -- delegatable via FUNDS_APPROVAL (see
// lib/permissions.ts). Lists PENDING requests first (what needs action),
// then recent resolved ones for context.
export async function GET() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "FUNDS_APPROVAL")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const requests = await prisma.transaction.findMany({
    where: { brokerId, type: { in: ["DEPOSIT", "WITHDRAWAL"] } },
    include: { account: { select: { accountNumber: true, fullName: true, balance: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  return NextResponse.json(
    requests.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      amount: t.amount.toString(),
      note: t.note,
      accountId: t.accountId,
      accountNumber: t.account.accountNumber,
      accountFullName: t.account.fullName,
      currentBalance: t.account.balance.toString(),
      createdAt: t.createdAt.toISOString(),
    }))
  );
}
