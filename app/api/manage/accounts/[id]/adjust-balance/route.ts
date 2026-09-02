import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { validateBalanceAdjustment, applyBalanceAdjustment } from "@/lib/balance-adjustment";

// BROKER_ADMIN by default -- per AdminRole.MANAGER's own schema comment
// ("not KYC/finance"), a direct balance correction (no underlying trade)
// is finance, not dealing-desk risk/ops -- delegatable via
// ACCOUNT_FINANCE (see lib/permissions.ts). First real usage of
// TransactionType.ADJUSTMENT and the "BALANCE_ADJUSTMENT" AuditLog
// action -- both existed as unimplemented placeholders before this.
// Same $transaction shape as the position-close routes: read balance
// inside the transaction, compute balanceAfter explicitly (not
// increment), write the Transaction row with balanceBefore/balanceAfter.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "ACCOUNT_FINANCE")) {
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

  const validationError = validateBalanceAdjustment({ amount, note });
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const result = await prisma.$transaction((tx) =>
    applyBalanceAdjustment(tx, { accountId: id, brokerId, amount, note, adminId: session!.adminId })
  );

  return NextResponse.json({
    accountId: id,
    amount: amount.toString(),
    balance: result.balanceAfter.toString(),
    transactionId: result.transactionId,
  });
}
