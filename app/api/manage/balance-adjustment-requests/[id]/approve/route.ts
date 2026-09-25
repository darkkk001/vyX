import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { approveBalanceAdjustmentRequest, BalanceAdjustmentError, BalanceRequestRaceError } from "@/lib/balance-adjustment";
import { publishTradingEvent } from "@/lib/nats";

// The checker half of the maker-checker gate: an admin holding the same
// finance authority the maker needed (BROKER_ADMIN, or a MANAGER with
// ACCOUNT_FINANCE) EXCEPT the one who requested it (see
// approveBalanceAdjustmentRequest's own different-admin check) approves,
// which is the moment the balance actually changes -- a PENDING request
// has no effect on the account at all until this. Same shape as
// app/api/manage/position-action-requests/[id]/approve/route.ts.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Pentest 2026-09-18 #3: the checker used to need only the MANAGER role,
  // so a manager with no finance permission at all could release a pending
  // adjustment it could never have filed -- four-eyes was one finance
  // signature plus anyone. Real four-eyes is two finance signatures.
  if (await forbidUnlessBrokerAdminOrPermission(session, "ACCOUNT_FINANCE")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const reviewNote = typeof body?.reviewNote === "string" ? body.reviewNote.trim().slice(0, 500) || null : null;

  let result: Awaited<ReturnType<typeof approveBalanceAdjustmentRequest>>;
  try {
    result = await prisma.$transaction((tx) => approveBalanceAdjustmentRequest(tx, { requestId: id, brokerId, adminId: session!.adminId, reviewNote }));
  } catch (e) {
    // the claim rolled back with the failure: the request is still PENDING (refused) or another admin had it (raced)
    if (e instanceof BalanceRequestRaceError) return NextResponse.json({ error: "request already reviewed by another admin" }, { status: 409 });
    if (e instanceof BalanceAdjustmentError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  for (const accountId of result.affectedAccountIds) {
    await publishTradingEvent("BalanceChanged", { account_id: accountId, broker_id: brokerId, transaction_id: result.transactionId }).catch(
      (err) => console.error("[approve-balance-adjustment] BalanceChanged publish failed", err)
    );
  }

  return NextResponse.json({ requestId: result.requestId, transactionId: result.transactionId, balance: result.balanceAfter.toString() });
}
