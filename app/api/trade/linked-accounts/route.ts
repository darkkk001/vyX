import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// Account Selector (docs/webtrader-stm-architecture-review.md §4.2): other
// accounts under the same broker sharing this trader's email -- e.g. a
// DEMO + LIVE pair created for the same person. This route only lists what
// they could switch to; the switch itself reuses POST /api/trade/login
// unchanged (a real re-login, matching MT4/5 behavior), not a lighter-weight
// swap of the existing session.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const current = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { email: true },
  });
  if (!current) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const linked = await prisma.account.findMany({
    where: {
      brokerId: session.brokerId,
      email: current.email,
      id: { not: session.accountId },
      status: "ACTIVE",
    },
    select: { accountNumber: true, accountType: true, currency: true, balance: true },
    orderBy: { accountNumber: "asc" },
  });

  return NextResponse.json(linked);
}
