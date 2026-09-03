import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: {
      id: true,
      accountNumber: true,
      accountMode: true,
      currency: true,
      leverage: true,
      balance: true,
      credit: true,
      status: true,
      fullName: true,
      twoFactorEnabled: true,
    },
  });

  if (!account || account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  return NextResponse.json(account);
}
