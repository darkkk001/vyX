import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// Cancel a resting PENDING order. No arbitrary status jumps — only
// PENDING -> CANCELLED is allowed here.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order || order.accountId !== session.accountId) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: `cannot cancel an order in status ${order.status}` }, { status: 409 });
  }

  const cancelled = await prisma.order.update({
    where: { id },
    data: { status: "CANCELLED" },
  });
  return NextResponse.json(cancelled);
}
