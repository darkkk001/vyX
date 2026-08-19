import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "INTERNAL_TRANSFERS")) {
    return null;
  }
  return session!;
}

// BROKER_ADMIN by default -- moves real balance between two accounts,
// same finance carve-out as adjust-balance/add-account -- delegatable
// via INTERNAL_TRANSFERS (see lib/permissions.ts).
export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const transfers = await prisma.transaction.findMany({
    where: { brokerId: session.brokerId!, type: { in: ["TRANSFER_OUT", "TRANSFER_IN"] } },
    include: { account: { select: { accountNumber: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json(
    transfers.map((t) => ({
      id: t.id,
      accountNumber: t.account.accountNumber,
      type: t.type,
      amount: t.amount.toString(),
      note: t.note,
      createdAt: t.createdAt.toISOString(),
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const fromAccountId = typeof body?.fromAccountId === "string" ? body.fromAccountId : "";
  const toAccountId = typeof body?.toAccountId === "string" ? body.toAccountId : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";

  if (!fromAccountId || !toAccountId) {
    return NextResponse.json({ error: "fromAccountId and toAccountId are required" }, { status: 400 });
  }
  if (fromAccountId === toAccountId) {
    return NextResponse.json({ error: "cannot transfer to the same account" }, { status: 400 });
  }
  if (!note) {
    return NextResponse.json({ error: "note is required for the audit trail" }, { status: 400 });
  }

  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(String(body?.amount ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid amount" }, { status: 400 });
  }
  if (!amount.gt(0)) {
    return NextResponse.json({ error: "amount must be positive" }, { status: 400 });
  }

  const [fromAccount, toAccount] = await Promise.all([
    prisma.account.findUnique({ where: { id: fromAccountId } }),
    prisma.account.findUnique({ where: { id: toAccountId } }),
  ]);
  if (!fromAccount || fromAccount.brokerId !== brokerId || !toAccount || toAccount.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }
  if (fromAccount.status !== "ACTIVE" || toAccount.status !== "ACTIVE") {
    return NextResponse.json({ error: "both accounts must be active" }, { status: 400 });
  }

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await tx.account.findUniqueOrThrow({ where: { id: fromAccountId } });
    if (fresh.balance.lt(amount)) {
      throw new Error("INSUFFICIENT_BALANCE");
    }
    const fromBalanceBefore = fresh.balance;
    const fromBalanceAfter = fromBalanceBefore.sub(amount);
    await tx.account.update({ where: { id: fromAccountId }, data: { balance: fromBalanceAfter } });
    const outTxn = await tx.transaction.create({
      data: {
        brokerId, accountId: fromAccountId, type: "TRANSFER_OUT", status: "COMPLETED",
        amount: amount.neg(), balanceBefore: fromBalanceBefore, balanceAfter: fromBalanceAfter,
        note: `Transfer to ${toAccount.accountNumber} — ${note}`, createdByAdminId: session.adminId,
      },
    });

    const toFresh = await tx.account.findUniqueOrThrow({ where: { id: toAccountId } });
    const toBalanceBefore = toFresh.balance;
    const toBalanceAfter = toBalanceBefore.add(amount);
    await tx.account.update({ where: { id: toAccountId }, data: { balance: toBalanceAfter } });
    const inTxn = await tx.transaction.create({
      data: {
        brokerId, accountId: toAccountId, type: "TRANSFER_IN", status: "COMPLETED",
        amount, balanceBefore: toBalanceBefore, balanceAfter: toBalanceAfter,
        note: `Transfer from ${fromAccount.accountNumber} — ${note}`, createdByAdminId: session.adminId,
      },
    });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "INTERNAL_TRANSFER",
        entityType: "Account",
        entityId: fromAccountId,
        oldValue: { fromBalance: fromBalanceBefore.toString(), toBalance: toBalanceBefore.toString() },
        newValue: { fromAccount: fromAccount.accountNumber, toAccount: toAccount.accountNumber, amount: amount.toString(), note },
      },
    });

    return { outTxn, inTxn };
  }).catch((e) => {
    if (e instanceof Error && e.message === "INSUFFICIENT_BALANCE") return null;
    throw e;
  });

  if (!result) {
    return NextResponse.json({ error: "insufficient balance on the source account" }, { status: 400 });
  }

  return NextResponse.json({ outTransactionId: result.outTxn.id, inTransactionId: result.inTxn.id });
}
