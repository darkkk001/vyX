import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { approveBalanceAdjustmentRequest } from "@/lib/balance-adjustment";

// The checker half of the maker-checker gate: any admin who can act on
// balance adjustments EXCEPT the one who requested it (see
// approveBalanceAdjustmentRequest's own different-admin check) approves,
// which is the moment the balance actually changes -- a PENDING request
// has no effect on the account at all until this. Same shape as
// app/api/manage/position-action-requests/[id]/approve/route.ts.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const reviewNote = typeof body?.reviewNote === "string" ? body.reviewNote.trim().slice(0, 500) || null : null;

  const result = await prisma.$transaction((tx) =>
    approveBalanceAdjustmentRequest(tx, { requestId: id, brokerId, adminId: session!.adminId, reviewNote })
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  return NextResponse.json({ requestId: result.requestId, transactionId: result.transactionId, balance: result.balanceAfter.toString() });
}
