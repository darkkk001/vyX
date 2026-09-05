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
      // 2026-09-05 P0 fix -- WebTrader's own margin-call banner/toast used
      // to hardcode 100% rather than reading this account's real
      // configured level (Group.marginCallLevel). Null group = ungrouped
      // account, same 100 fallback Group.marginCallLevel's own schema
      // default already uses everywhere else (lib/margin.ts, lib/risk-monitor.ts).
      group: { select: { marginCallLevel: true } },
    },
  });

  if (!account || account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const { group, ...rest } = account;
  return NextResponse.json({ ...rest, marginCallLevel: (group?.marginCallLevel ?? 100).toString() });
}
