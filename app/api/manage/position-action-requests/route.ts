import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Backoffice's own approval queue for MANAGER-initiated position actions
// (Reverse/Void/Delete) -- see lib/position-actions.ts's own doc comment
// on the maker-checker gate. Defaults to PENDING only (the queue a
// checker actually needs to work off); ?status=ALL returns everything
// broker-scoped, newest first, for the audit-style "what's been
// reviewed" view.
export async function GET(request: Request) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status") === "ALL" ? undefined : "PENDING";

  const rows = await prisma.positionActionRequest.findMany({
    where: { brokerId, ...(statusFilter ? { status: statusFilter } : {}) },
    include: {
      position: {
        select: {
          id: true,
          side: true,
          volume: true,
          openPrice: true,
          status: true,
          symbol: { select: { name: true } },
          account: { select: { accountNumber: true, fullName: true } },
        },
      },
      requestedByAdmin: { select: { email: true } },
      reviewedByAdmin: { select: { email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      actionType: r.actionType,
      status: r.status,
      reason: r.reason,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      requestedByAdminId: r.requestedByAdminId,
      requestedByName: r.requestedByAdmin.email,
      reviewedByName: r.reviewedByAdmin?.email ?? null,
      position: {
        id: r.position.id,
        symbolName: r.position.symbol.name,
        side: r.position.side,
        volume: r.position.volume.toString(),
        openPrice: r.position.openPrice.toString(),
        status: r.position.status,
        accountNumber: r.position.account.accountNumber,
        accountFullName: r.position.account.fullName,
      },
    }))
  );
}
