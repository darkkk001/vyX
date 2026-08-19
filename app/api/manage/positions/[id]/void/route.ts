import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Corrects an admin's own erroneous manual entry -- never a real trade,
// so no Transaction/balance change at all (a manual open never moved
// balance in the first place). Restricted to positions whose origin
// order's idempotency key starts with "manual_" (the exact prefix
// app/api/manage/positions/route.ts's manual-open already stamps), so a
// real trader-originated position can never be voided this way.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const position = await prisma.position.findUnique({
    where: { id },
    include: { originOrder: { select: { idempotencyKey: true } }, symbol: { select: { name: true } }, account: { select: { accountNumber: true } } },
  });
  if (!position || position.brokerId !== brokerId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  if (position.status !== "OPEN") {
    return NextResponse.json({ error: "position is not open" }, { status: 409 });
  }
  if (!position.originOrder.idempotencyKey.startsWith("manual_")) {
    return NextResponse.json({ error: "only a manually-opened position can be voided -- close a real position instead" }, { status: 400 });
  }

  const voided = await prisma.$transaction(async (tx) => {
    const updated = await tx.position.update({
      where: { id },
      data: { status: "VOIDED", closedAt: new Date(), closedByAdminId: session.adminId },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "MANUAL_POSITION_VOID",
        entityType: "Position",
        entityId: id,
        oldValue: { status: "OPEN" },
        newValue: {
          status: "VOIDED",
          accountNumber: position.account.accountNumber,
          symbol: position.symbol.name,
          side: position.side,
          volume: position.volume.toString(),
        },
      },
    });
    return updated;
  });

  return NextResponse.json({ id: voided.id, status: voided.status });
}
