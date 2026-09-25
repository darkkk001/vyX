import { NextRequest, NextResponse } from "next/server";
import { publishTradingEvent } from "@/lib/nats";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { executeTransfer, TransferError } from "@/lib/transfer";
import { balanceAdjustmentNeedsApproval, requestBalanceAdjustment, BalanceAdjustmentError } from "@/lib/balance-adjustment";

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

  // Audit 2026-09-24 (money): same client only, the source's open positions keep their margin, and the same
  // maker-checker rule as a balance adjustment -- a MANAGER's transfer is filed for a second admin's approval
  // (lib/balance-adjustment.ts, kind TRANSFER); BROKER_ADMIN executes directly. lib/transfer.ts runs every check.
  if (balanceAdjustmentNeedsApproval(session.role as "MANAGER" | "BROKER_ADMIN")) {
    try {
      const created = await prisma.$transaction((tx) =>
        requestBalanceAdjustment(tx, { brokerId, accountId: fromAccountId, toAccountId, amount, note, adminId: session.adminId, kind: "TRANSFER" })
      );
      return NextResponse.json({ pending: true, requestId: created.id }, { status: 202 });
    } catch (e) {
      if (e instanceof BalanceAdjustmentError) return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
  }

  let result: Awaited<ReturnType<typeof executeTransfer>>;
  try {
    result = await prisma.$transaction((tx) => executeTransfer(tx, { brokerId, fromAccountId, toAccountId, amount, note, adminId: session.adminId }));
  } catch (e) {
    if (e instanceof TransferError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  // both accounts' terminals refresh at once (after the commit; best-effort, never fails the transfer)
  await publishTradingEvent("BalanceChanged", { account_id: fromAccountId, broker_id: brokerId, transaction_id: result.outTxn.id }).catch(() => {});
  await publishTradingEvent("BalanceChanged", { account_id: toAccountId, broker_id: brokerId, transaction_id: result.inTxn.id }).catch(() => {});

  return NextResponse.json({ outTransactionId: result.outTxn.id, inTransactionId: result.inTxn.id });
}
