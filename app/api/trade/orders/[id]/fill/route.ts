import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { triggerPendingOrder } from "@/lib/pending-trigger";

// POST /api/trade/orders/[id]/fill -- the trigger report from an OLDER terminal (audit 2026-09-24 Batch 4). Pending
// LIMIT / STOP orders now trigger server-side (lib/pending-trigger.ts, engine tick hook + passes); the current
// terminal no longer calls this. Kept for installed older builds: it runs the very same routine, so the order is
// claimed once (a server trigger and this POST can never both fill it), and a lasting failure REJECTS the order --
// which also ends an old terminal's re-POST-every-tick loop (it gets 409 "cannot fill an order in status REJECTED").
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const requestedFillPrice = body?.price != null ? String(body.price) : null;
  if (!requestedFillPrice) {
    return NextResponse.json({ error: "price is required" }, { status: 400 });
  }
  const order = await prisma.order.findUnique({ where: { id }, select: { accountId: true, status: true } });
  if (!order || order.accountId !== session.accountId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: `cannot fill an order in status ${order.status}` }, { status: 409 });
  }

  const r = await triggerPendingOrder(id, requestedFillPrice, "client");
  switch (r.kind) {
    case "filled":
      return NextResponse.json({ order: r.order, position: r.position });
    case "queued":
      return NextResponse.json({ order: r.order, position: null });
    case "rejected":
      return NextResponse.json({ error: r.reason, rejected: true, ...(r.detail ?? {}) }, { status: 400 });
    case "kept":
      return NextResponse.json({ error: r.reason, pending: true }, { status: 409 });
    case "skipped":
      return NextResponse.json({ error: `cannot fill: ${r.reason}` }, { status: 409 });
  }
}
