import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Only SUPER_ADMIN may change a broker's execution engine -- this is a
// platform-level infrastructure setting, not something a broker's own
// BROKER_ADMIN should control. See ExecutionEngine's schema comment /
// ADR-003: setting this to RUST does NOT currently change any trading
// behavior, no app/api/trade/* route reads it yet.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const executionEngine = body?.executionEngine === "LEGACY" || body?.executionEngine === "RUST" ? body.executionEngine : null;
  if (!executionEngine) {
    return NextResponse.json({ error: "executionEngine must be LEGACY or RUST" }, { status: 400 });
  }

  const existing = await prisma.broker.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const broker = await tx.broker.update({ where: { id }, data: { executionEngine } });
    await tx.auditLog.create({
      data: {
        brokerId: id,
        actorAdminId: session!.adminId,
        action: "BROKER_EXECUTION_ENGINE_CHANGED",
        entityType: "Broker",
        entityId: id,
        oldValue: { executionEngine: existing.executionEngine },
        newValue: { executionEngine: broker.executionEngine },
      },
    });
    return broker;
  });

  return NextResponse.json({ id: updated.id, executionEngine: updated.executionEngine });
}
