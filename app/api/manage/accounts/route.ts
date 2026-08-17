import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const accounts = await prisma.account.findMany({
    where: { brokerId: session.brokerId! },
    include: { group: { select: { id: true, name: true } } },
    orderBy: { accountNumber: "asc" },
  });

  return NextResponse.json(
    accounts.map((a) => ({
      id: a.id,
      accountNumber: a.accountNumber,
      fullName: a.fullName,
      email: a.email,
      accountType: a.accountType,
      currency: a.currency,
      leverage: a.leverage,
      balance: a.balance.toString(),
      credit: a.credit.toString(),
      status: a.status,
      groupId: a.groupId,
      groupName: a.group?.name ?? null,
    }))
  );
}
