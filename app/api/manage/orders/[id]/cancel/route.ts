import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { publishTradingEvent } from "@/lib/nats";
import { orderAuditFields } from "@/lib/order-audit";

// Phase 2 batch 1 (audit 2026-09-24, DEAL "RESTING row CANCEL is a toast only"): a dealer cancels a client's RESTING
// order (LIMIT / STOP, status PENDING) from the dealing screen. Same outcome as the trader's own cancel
// (app/api/trade/orders/[id] DELETE) -- status CANCELLED, OrderCancelled to the trader's terminal -- but staff-side:
// the DEALING permission, a required reason, and the audit row names the admin. Orders awaiting a dealer (MARKET)
// are answered with REJECT in the dealing queue instead, not here.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (await forbidUnlessBrokerAdminOrPermission(session, "DEALING")) {
    return NextResponse.json({ error: "forbidden", permission: "DEALING", permissionLabel: PERMISSION_LABELS.DEALING }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json({ error: "reason is required for the audit trail" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id },
    include: { symbol: { select: { name: true } }, account: { select: { accountNumber: true } } },
  });
  if (!order || order.brokerId !== brokerId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.type === "MARKET") {
    return NextResponse.json({ error: "a market order awaiting the dealer is rejected from the queue, not cancelled" }, { status: 409 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: `cannot cancel an order in status ${order.status}` }, { status: 409 });
  }

  // status-guarded: a trigger fill racing this cancel wins or loses cleanly, never both
  const cancelled = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED" } });
    if (res.count === 0) return null;
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "DEALER_CANCELLED_PENDING_ORDER",
        entityType: "Order",
        entityId: id,
        oldValue: { ...orderAuditFields(order, order.symbol.name, order.account.accountNumber), status: order.status },
        newValue: { status: "CANCELLED", cancelledBy: "DEALER", cancelledAt: new Date().toISOString(), reason },
      },
    });
    return tx.order.findUniqueOrThrow({ where: { id } });
  });
  if (!cancelled) {
    return NextResponse.json({ error: "the order is no longer pending (it filled or was cancelled meanwhile)" }, { status: 409 });
  }
  await publishTradingEvent("OrderCancelled", { order_id: id, account_id: order.accountId, broker_id: brokerId, reason }).catch(() => {});
  return NextResponse.json({ order: cancelled });
}
