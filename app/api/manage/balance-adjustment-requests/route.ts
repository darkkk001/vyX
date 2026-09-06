import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Backoffice's own approval queue for MANAGER-initiated balance
// adjustments -- see lib/balance-adjustment.ts's own doc comment on the
// maker-checker gate, and app/api/manage/position-action-requests/
// route.ts for the identical shape this mirrors. Defaults to PENDING
// only (the queue a checker actually needs to work off); ?status=ALL
// returns everything broker-scoped, newest first, for the audit-style
// "what's been reviewed" view.
export async function GET(request: Request) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status") === "ALL" ? undefined : "PENDING";

  const rows = await prisma.balanceAdjustmentRequest.findMany({
    where: { brokerId, ...(statusFilter ? { status: statusFilter } : {}) },
    include: {
      account: { select: { accountNumber: true, fullName: true, balance: true } },
      requestedByAdmin: { select: { email: true } },
      reviewedByAdmin: { select: { email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      amount: r.amount.toString(),
      note: r.note,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      requestedByAdminId: r.requestedByAdminId,
      requestedByName: r.requestedByAdmin.email,
      reviewedByName: r.reviewedByAdmin?.email ?? null,
      account: {
        id: r.accountId,
        accountNumber: r.account.accountNumber,
        fullName: r.account.fullName,
        balance: r.account.balance.toString(),
      },
    }))
  );
}
