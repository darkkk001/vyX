import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// BROKER_ADMIN only -- per AdminRole.MANAGER's own schema comment
// ("not KYC/finance"), a direct balance correction (no underlying trade)
// is finance, not dealing-desk risk/ops. First real usage of
// TransactionType.ADJUSTMENT and the "BALANCE_ADJUSTMENT" AuditLog
// action -- both existed as unimplemented placeholders before this.
// Same $transaction shape as the position-close routes: read balance
// inside the transaction, compute balanceAfter explicitly (not
// increment), write the Transaction row with balanceBefore/balanceAfter.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const account = await prisma.account.findUnique({ where: { id } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(String(body?.amount ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid amount" }, { status: 400 });
  }
  if (amount.isZero()) {
    return NextResponse.json({ error: "amount must not be zero" }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!note) {
    return NextResponse.json({ error: "note is required for a balance adjustment" }, { status: 400 });
  }

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await tx.account.findUniqueOrThrow({ where: { id } });
    const balanceBefore = fresh.balance;
    const balanceAfter = balanceBefore.add(amount);

    await tx.account.update({ where: { id }, data: { balance: balanceAfter } });

    const transaction = await tx.transaction.create({
      data: {
        brokerId,
        accountId: id,
        type: "ADJUSTMENT",
        status: "COMPLETED",
        amount,
        balanceBefore,
        balanceAfter,
        note,
        createdByAdminId: session!.adminId,
      },
    });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "BALANCE_ADJUSTMENT",
        entityType: "Account",
        entityId: id,
        oldValue: { balance: balanceBefore.toString() },
        newValue: { balance: balanceAfter.toString(), amount: amount.toString(), note },
      },
    });

    return { transaction, balanceAfter };
  });

  return NextResponse.json({
    accountId: id,
    amount: amount.toString(),
    balance: result.balanceAfter.toString(),
    transactionId: result.transaction.id,
  });
}
