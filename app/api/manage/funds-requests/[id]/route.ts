import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

// Approve/reject a PENDING deposit or withdrawal request -- BROKER_ADMIN
// by default, delegatable via FUNDS_APPROVAL (see lib/permissions.ts).
// WITHDRAWAL only: maker-checker -- the first APPROVE just marks it
// (status stays PENDING, no balance change); a second APPROVE by a
// *different* admin is what actually completes it. DEPOSIT stays
// single-approval (mockup's own scope -- only withdrawals move money
// out). This is the one place a Transaction row is ever updated after
// creation (see the field's own schema comment) -- resolving a PENDING
// state-machine row, not editing an executed trade, so it doesn't
// conflict with CLAUDE.md's never-edit-history rule.
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
    await prisma.$transaction(async (tx) => {
      await tx.transaction.update({ where: { id }, data: { markedByAdminId: null, markedAt: null } });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "FUNDS_REQUEST_MARK_CANCELLED",
          entityType: "Transaction",
          entityId: id,
          oldValue: { markedByAdminId: existing.markedByAdminId },
          newValue: { markedByAdminId: null },
        },
      });
    });
    return NextResponse.json({ id, status: existing.status, marked: false });
  }

  if (action === "REJECT") {
    const rejected = await prisma.$transaction(async (tx) => {
      const updated = await tx.transaction.update({
        where: { id },
        data: { status: "REJECTED", reviewedByAdminId: session!.adminId, markedByAdminId: null, markedAt: null, note: note ?? existing.note },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "FUNDS_REQUEST_REJECTED",
          entityType: "Transaction",
          entityId: id,
          oldValue: { status: "PENDING" },
          newValue: { status: "REJECTED", note: note ?? existing.note },
        },
      });
      return updated;
    });
    return NextResponse.json({ id: rejected.id, status: rejected.status });
  }

  // APPROVE
  if (existing.type === "WITHDRAWAL" && !existing.markedByAdminId) {
    // First approval on a withdrawal -- mark only, no balance change yet.
    const marked = await prisma.$transaction(async (tx) => {
      const updated = await tx.transaction.update({
        where: { id },
        data: { markedByAdminId: session!.adminId, markedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "FUNDS_REQUEST_MARKED_FOR_APPROVAL",
          entityType: "Transaction",
          entityId: id,
          newValue: { markedByAdminId: session!.adminId },
        },
      });
      return updated;
    });
    return NextResponse.json({ id: marked.id, status: marked.status, marked: true });
  }
  if (existing.type === "WITHDRAWAL" && existing.markedByAdminId === session!.adminId) {
    return NextResponse.json({ error: "a different staff member must confirm this withdrawal" }, { status: 400 });
  }

  try {
    const approved = await prisma.$transaction(async (tx) => {
      // Re-fetch the account's CURRENT balance -- trading activity
      // between request and review can have moved it, so a withdrawal
      // that fit at request time might not fit anymore.
      const account = await tx.account.findUniqueOrThrow({ where: { id: existing.accountId } });
      const balanceBefore = account.balance;
      const balanceAfter = balanceBefore.add(existing.amount); // amount already signed (negative for withdrawal)

      if (balanceAfter.lt(0)) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      await tx.account.update({ where: { id: existing.accountId }, data: { balance: balanceAfter } });

      const updated = await tx.transaction.update({
        where: { id },
        data: {
          status: "COMPLETED",
          balanceBefore,
          balanceAfter,
          reviewedByAdminId: session!.adminId,
          note: note ?? existing.note,
        },
      });

      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "FUNDS_REQUEST_APPROVED",
          entityType: "Transaction",
          entityId: id,
          oldValue: { status: "PENDING", markedByAdminId: existing.markedByAdminId },
          newValue: { status: "COMPLETED", balanceBefore: balanceBefore.toString(), balanceAfter: balanceAfter.toString() },
        },
      });

      return updated;
    });

    return NextResponse.json({
      id: approved.id,
      status: approved.status,
      balanceAfter: approved.balanceAfter.toString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      return NextResponse.json(
        { error: "account balance is no longer sufficient for this withdrawal -- reject or ask the trader to resubmit" },
        { status: 409 }
      );
    }
    throw error;
  }
}
