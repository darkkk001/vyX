import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

const VALID_STATUS = ["PROSPECTIVE", "NEGOTIATING", "CONTRACTED", "CONNECTED"];

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const existing = await prisma.liquidityProvider.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const data: { status?: "PROSPECTIVE" | "NEGOTIATING" | "CONTRACTED" | "CONNECTED"; notes?: string | null } = {};

  if (body?.status != null) {
    if (!VALID_STATUS.includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    data.status = body.status;
  }
  if ("notes" in (body ?? {})) {
    data.notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const provider = await tx.liquidityProvider.update({ where: { id }, data });
    if (data.status !== undefined) {
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "LP_STATUS_CHANGED",
          entityType: "LiquidityProvider",
          entityId: id,
          oldValue: { status: existing.status },
          newValue: { status: provider.status },
        },
      });
    }
    return provider;
  });

  return NextResponse.json({ id: updated.id, status: updated.status, notes: updated.notes });
}
