import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import {
  validateBalanceAdjustment,
  applyBalanceAdjustment,
  requestBalanceAdjustment,
  balanceAdjustmentNeedsApproval,
  BalanceAdjustmentError,
} from "@/lib/balance-adjustment";

// BROKER_ADMIN by default -- per AdminRole.MANAGER's own schema comment
// ("not KYC/finance"), a direct balance correction (no underlying trade)
// is finance, not dealing-desk risk/ops -- delegatable via
// ACCOUNT_FINANCE (see lib/permissions.ts). First real usage of
// TransactionType.ADJUSTMENT and the "BALANCE_ADJUSTMENT" AuditLog
// action -- both existed as unimplemented placeholders before this.
// Same $transaction shape as the position-close routes: read balance
// inside the transaction, compute balanceAfter explicitly (not
// increment), write the Transaction row with balanceBefore/balanceAfter.
//
// 2026-09-06 Section D audit fix: a MANAGER's call (even one holding the
// delegated ACCOUNT_FINANCE permission) now only ever creates a PENDING
// BalanceAdjustmentRequest -- same maker-checker gate
// app/api/manage/positions/[id]/{reverse,void}/route.ts already apply to
// position actions, extended here since a direct balance correction is
// real money moving with no underlying trade to double-check against.
// BROKER_ADMIN still executes immediately, same "trusted to execute
// solo" rule.
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

  if (balanceAdjustmentNeedsApproval(session!.role as "MANAGER" | "BROKER_ADMIN")) {
    try {
      const created = await prisma.$transaction((tx) =>
        requestBalanceAdjustment(tx, { brokerId, accountId: id, amount, note, adminId: session!.adminId })
      );
      return NextResponse.json({ pending: true, requestId: created.id }, { status: 202 });
    } catch (err) {
      const message = err instanceof BalanceAdjustmentError ? err.message : "adjustment request failed";
      return NextResponse.json({ error: message }, { status: 409 });
    }
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
