import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import {
  resolveFundsApprovalStep,
  markFundsRequestForApproval,
  cancelFundsRequestMark,
  rejectFundsRequest,
  approveFundsRequest,
} from "@/lib/funds-approval";

// Approve/reject a PENDING deposit or withdrawal request -- BROKER_ADMIN
// by default, delegatable via FUNDS_APPROVAL (see lib/permissions.ts).
// WITHDRAWAL only: maker-checker -- the first APPROVE just marks it
// (status stays PENDING, no balance change); a second APPROVE by a
// *different* admin is what actually completes it. DEPOSIT stays
// single-approval (mockup's own scope -- only withdrawals move money
// out). This is the one place a Transaction row is ever updated after
// creation (see the field's own schema comment) -- resolving a PENDING
// state-machine row, not editing an executed trade, so it doesn't
// conflict with this app's own never-edit-history invariant for
// completed transactions.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "FUNDS_APPROVAL")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const existing = await prisma.transaction.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "request not found" }, { status: 404 });
  }
  if (existing.type !== "DEPOSIT" && existing.type !== "WITHDRAWAL") {
    return NextResponse.json({ error: "not a funds request" }, { status: 400 });
  }
  if (existing.status !== "PENDING") {
    return NextResponse.json({ error: "request already reviewed" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action === "APPROVE" ? "APPROVE" : body?.action === "REJECT" ? "REJECT" : body?.action === "CANCEL_MARK" ? "CANCEL_MARK" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be APPROVE, REJECT, or CANCEL_MARK" }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : null;

  if (action === "CANCEL_MARK") {
    if (!existing.markedByAdminId) {
      return NextResponse.json({ error: "request is not marked" }, { status: 409 });
    }
    await prisma.$transaction((tx) =>
      cancelFundsRequestMark(tx, {
        transactionId: id,
        brokerId,
        previousMarkedByAdminId: existing.markedByAdminId!,
        actorAdminId: session!.adminId,
      })
    );
    return NextResponse.json({ id, status: existing.status, marked: false });
  }

  if (action === "REJECT") {
    const rejected = await prisma.$transaction((tx) =>
      rejectFundsRequest(tx, { transactionId: id, brokerId, adminId: session!.adminId, note: note ?? existing.note })
    );
    return NextResponse.json(rejected);
  }

  // APPROVE
  const step = resolveFundsApprovalStep({
    type: existing.type as "DEPOSIT" | "WITHDRAWAL",
    markedByAdminId: existing.markedByAdminId,
    actingAdminId: session!.adminId,
  });
  if (step.step === "error") {
    return NextResponse.json({ error: step.error }, { status: 400 });
  }
  if (step.step === "mark") {
    const marked = await prisma.$transaction((tx) =>
      markFundsRequestForApproval(tx, { transactionId: id, brokerId, adminId: session!.adminId })
    );
    return NextResponse.json({ id: marked.transactionId, status: existing.status, marked: true });
  }

  const approved = await prisma.$transaction((tx) =>
    approveFundsRequest(tx, {
      transactionId: id,
      brokerId,
      accountId: existing.accountId,
      amount: existing.amount,
      adminId: session!.adminId,
      note: note ?? existing.note,
      type: existing.type as "DEPOSIT" | "WITHDRAWAL",
    })
  );
  if (!approved.ok) {
    return NextResponse.json({ error: approved.error }, { status: 409 });
  }
  return NextResponse.json({ id: approved.transactionId, status: "COMPLETED", balanceAfter: approved.balanceAfter.toString() });
}
