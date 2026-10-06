import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { publishAccountUpdated } from "@/lib/account-events";
import { balanceAdjustmentNeedsApproval, requestBalanceAdjustment, BalanceAdjustmentError } from "@/lib/balance-adjustment";
import { applyCreditAdjustment, validateCreditAdjustment, CreditAdjustmentError } from "@/lib/credit-adjustment";

// Add (+) / remove (-) Credit ($) on one account (2026-09-28, owner decisions). Same permission and maker-checker as
// a balance adjustment (app/api/manage/accounts/[id]/adjust-balance): BROKER_ADMIN or ACCOUNT_FINANCE may ask; a
// MANAGER's change is filed for a different admin to approve (202 { pending, requestId }), a BROKER_ADMIN's applies at
// once. The balance never moves; a removal may not take credit below 0 or open positions to margin call.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "ACCOUNT_FINANCE")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const account = await prisma.account.findUnique({ where: { id }, select: { brokerId: true } });
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
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  const invalid = validateCreditAdjustment({ amount, note });
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  if (balanceAdjustmentNeedsApproval(session!.role as "MANAGER" | "BROKER_ADMIN")) {
    try {
      const req = await prisma.$transaction((tx) => requestBalanceAdjustment(tx, { brokerId, accountId: id, amount, note, adminId: session!.adminId, kind: "CREDIT" }));
      return NextResponse.json({ pending: true, requestId: req.id }, { status: 202 });
    } catch (e) {
      if (e instanceof BalanceAdjustmentError) return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
  }

  try {
    const r = await prisma.$transaction((tx) => applyCreditAdjustment(tx, { accountId: id, brokerId, amount, note, adminId: session!.adminId }));
    await publishAccountUpdated(brokerId, id, "account");
    return NextResponse.json({ pending: false, transactionId: r.transactionId, creditBefore: r.creditBefore.toFixed(2), creditAfter: r.creditAfter.toFixed(2) });
  } catch (e) {
    if (e instanceof CreditAdjustmentError) return NextResponse.json({ error: e.message, code: "CREDIT_REFUSED" }, { status: 400 });
    throw e;
  }
}
