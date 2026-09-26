import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const existing = await prisma.lpRoutingRule.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== session!.brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Phase 2 batch 5: deleted and audited together (a rule delete used to write no audit row)
  await prisma.$transaction(async (tx) => {
    await tx.lpRoutingRule.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        brokerId: session!.brokerId!,
        actorAdminId: session!.adminId,
        action: "LP_ROUTING_RULE_DELETED",
        entityType: "LpRoutingRule",
        entityId: id,
        oldValue: { liquidityProviderId: existing.liquidityProviderId, symbolId: existing.symbolId, priority: existing.priority, notes: existing.notes },
      },
    });
  });
  return NextResponse.json({ ok: true });
}
