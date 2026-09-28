import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { publishTradingEvent } from "@/lib/nats";
import { publishFundsRequestChanged, notifyFundsRequestResolved } from "@/lib/funds-events";
import { withdrawalKycApproved, WITHDRAWAL_KYC_ADMIN_MESSAGE, WITHDRAWAL_KYC_CODE } from "@/lib/withdrawal-kyc";
import {
  resolveFundsApprovalStep,
  markFundsRequestForApproval,
  cancelFundsRequestMark,
  rejectFundsRequest,
  approveFundsRequest,
  FundsRequestRaceError,
} from "@/lib/funds-approval";

const racedResponse = () => NextResponse.json({ error: "request already reviewed by another admin" }, { status: 409 });
const raced = (e: unknown) => (e instanceof FundsRequestRaceError ? null : Promise.reject(e));

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
  // issue 109: an empty note is no note ("" used to erase the trader's own note)
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;

  if (action === "CANCEL_MARK") {
    if (!existing.markedByAdminId) {
      return NextResponse.json({ error: "request is not marked" }, { status: 409 });
    }
    // Phase 2 batch 8 (issue 111, owner decision): only the admin who marked it may withdraw the mark
    if (existing.markedByAdminId !== session!.adminId) {
      return NextResponse.json({ error: "only the staff member who marked this withdrawal can cancel the mark" }, { status: 403 });
    }
    await prisma.$transaction((tx) =>
      cancelFundsRequestMark(tx, {
        transactionId: id,
        brokerId,
        previousMarkedByAdminId: existing.markedByAdminId!,
        actorAdminId: session!.adminId,
      })
    );
    await publishFundsRequestChanged({ brokerId, accountId: existing.accountId, transactionId: id, change: "unmarked" });
    return NextResponse.json({ id, status: existing.status, marked: false });
  }

  if (action === "REJECT") {
    const rejected = await prisma
      .$transaction((tx) => rejectFundsRequest(tx, { transactionId: id, brokerId, adminId: session!.adminId, note }))
      .catch(raced);
    if (!rejected) return racedResponse();
    await publishFundsRequestChanged({ brokerId, accountId: existing.accountId, transactionId: id, change: "rejected" });
    await notifyFundsRequestResolved({ brokerId, accountId: existing.accountId, transactionId: id, kind: existing.type as "DEPOSIT" | "WITHDRAWAL", outcome: "REJECTED", amount: existing.amount.abs().toString(), reviewNote: note });
    return NextResponse.json(rejected);
  }

  // APPROVE -- Broker.withdrawalApproval (owner decision D5): SINGLE lets one BROKER_ADMIN complete a withdrawal
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { withdrawalApproval: true } });
  const step = resolveFundsApprovalStep({
    type: existing.type as "DEPOSIT" | "WITHDRAWAL",
    markedByAdminId: existing.markedByAdminId,
    actingAdminId: session!.adminId,
    actingRole: session!.role === "BROKER_ADMIN" ? "BROKER_ADMIN" : "MANAGER",
    withdrawalApproval: broker.withdrawalApproval,
  });
  if (step.step === "error") {
    return NextResponse.json({ error: step.error }, { status: 400 });
  }
  // Phase 2 batch 8 (issue 132): no withdrawal is marked or paid without approved KYC (approveFundsRequest checks it
  // again inside the paying transaction)
  if (existing.type === "WITHDRAWAL" && !(await withdrawalKycApproved(prisma, existing.accountId))) {
    return NextResponse.json({ error: WITHDRAWAL_KYC_ADMIN_MESSAGE, code: WITHDRAWAL_KYC_CODE }, { status: 409 });
  }
  if (step.step === "mark") {
    const marked = await prisma
      .$transaction((tx) => markFundsRequestForApproval(tx, { transactionId: id, brokerId, adminId: session!.adminId }))
      .catch(raced);
    if (!marked) return racedResponse();
    await publishFundsRequestChanged({ brokerId, accountId: existing.accountId, transactionId: id, change: "marked" });
    return NextResponse.json({ id: marked.transactionId, status: existing.status, marked: true });
  }

  const approved = await prisma
    .$transaction((tx) =>
      approveFundsRequest(tx, {
        transactionId: id,
        brokerId,
        accountId: existing.accountId,
        amount: existing.amount,
        adminId: session!.adminId,
        note,
        type: existing.type as "DEPOSIT" | "WITHDRAWAL",
        approvalMode: step.single ? "SINGLE" : "DUAL",
        markedByAdminId: existing.markedByAdminId,
      })
    )
    .catch(raced);
  if (!approved) return racedResponse();
  if (!approved.ok) {
    return NextResponse.json({ error: approved.error }, { status: 409 });
  }
  // deposit/withdrawal completed: nudge the trader's terminal to refresh balance + Balance history
  await publishTradingEvent("BalanceChanged", { account_id: existing.accountId, broker_id: brokerId, transaction_id: approved.transactionId }).catch(
    (err) => console.error("[funds-requests] BalanceChanged publish failed", err)
  );
  await publishFundsRequestChanged({ brokerId, accountId: existing.accountId, transactionId: id, change: "approved" });
  await notifyFundsRequestResolved({ brokerId, accountId: existing.accountId, transactionId: id, kind: existing.type as "DEPOSIT" | "WITHDRAWAL", outcome: "APPROVED", amount: existing.amount.abs().toString(), reviewNote: note });
  return NextResponse.json({ id: approved.transactionId, status: "COMPLETED", balanceAfter: approved.balanceAfter.toString() });
}
