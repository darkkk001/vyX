import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { createNotification } from "@/lib/notifications";

// Deposit/withdrawal requests -- see components/webtrader/WebTrader.tsx's
// funds modal, previously stubbed with a "not yet available" toast.
// Creates a PENDING Transaction; balance never changes here, only on
// admin review (app/api/manage/funds-requests/[id]/route.ts) -- see that
// file's doc comment for the full state-machine reasoning.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  // ADJUSTMENT included alongside the trader's own DEPOSIT/WITHDRAWAL
  // requests -- a staff-initiated balance adjustment (Manager backoffice's
  // "Adjust Balance" on an account, app/api/manage/accounts/[id]/adjust-
  // balance) changes this same balance but previously showed up nowhere
  // in the trader's own UI (not here, since it isn't a DEPOSIT/WITHDRAWAL
  // type, and not the trade-history tab either, which only lists closed
  // positions) -- reported live as "my withdrawal isn't showing up
  // anywhere," even though the balance change itself was correct.
  const requests = await prisma.transaction.findMany({
    where: { accountId: session.accountId, type: { in: ["DEPOSIT", "WITHDRAWAL", "ADJUSTMENT"] } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    requests.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      amount: t.amount.toString(),
      note: t.note,
      createdAt: t.createdAt.toISOString(),
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const type = body?.type === "WITHDRAWAL" ? "WITHDRAWAL" : body?.type === "DEPOSIT" ? "DEPOSIT" : null;
  if (!type) {
    return NextResponse.json({ error: "type must be DEPOSIT or WITHDRAWAL" }, { status: 400 });
  }

  let requestedAmount: Prisma.Decimal;
  try {
    requestedAmount = new Prisma.Decimal(String(body?.amount ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid amount" }, { status: 400 });
  }
  if (!requestedAmount.gt(0)) {
    return NextResponse.json({ error: "amount must be positive" }, { status: 400 });
  }

  const account = await prisma.account.findUniqueOrThrow({ where: { id: session.accountId } });
  if (account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account is not active" }, { status: 400 });
  }

  // Signed amount, matching Transaction.amount's own doc comment
  // ("negative = debit") -- a withdrawal reduces balance once approved.
  const amount = type === "WITHDRAWAL" ? requestedAmount.negated() : requestedAmount;

  // Basic sanity guard, not a funds-hold/reservation system: can't
  // request to withdraw more than the balance right now. Approval
  // re-checks this against whatever the balance is AT approval time,
  // since trading activity between request and review can change it.
  if (type === "WITHDRAWAL" && requestedAmount.gt(account.balance)) {
    return NextResponse.json({ error: "withdrawal amount exceeds available balance" }, { status: 400 });
  }

  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : null;

  const created = await prisma.transaction.create({
    data: {
      brokerId: session.brokerId,
      accountId: session.accountId,
      type,
      status: "PENDING",
      amount,
      // Nothing has changed yet -- both reflect the current balance
      // until an admin approves or rejects this request.
      balanceBefore: account.balance,
      balanceAfter: account.balance,
      note,
    },
  });

  await createNotification(prisma, {
    brokerId: session.brokerId,
    type: "FUNDS_REQUEST",
    title: `New ${type.toLowerCase()} request`,
    body: `${account.accountNumber} requested ${requestedAmount.toString()}${note ? ` — ${note}` : ""}`,
    entityType: "Transaction",
    entityId: created.id,
  });

  return NextResponse.json(
    { id: created.id, type: created.type, status: created.status, amount: created.amount.toString() },
    { status: 201 }
  );
}
