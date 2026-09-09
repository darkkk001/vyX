import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

// Per-group full trading halt -- see Group.tradingHaltedAt's own schema
// comment (the "stop this group entirely" gate Group.tradingRestriction
// has no value for, since that one can only narrow to one side). Same
// permission and on/off-via-timestamp shape as the broker-wide halt in
// app/api/manage/risk/route.ts, kept as its own dedicated route (rather
// than folded into the general group-edit PATCH at
// app/api/manage/groups/[id]/route.ts) so an emergency action never
// requires resubmitting that whole form -- one focused endpoint, same
// convention as app/api/manage/dealing-desk-toggle/route.ts.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "EMERGENCY_CONTROLS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const existing = await prisma.group.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "group not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (typeof body?.halted !== "boolean") {
    return NextResponse.json({ error: "halted must be a boolean" }, { status: 400 });
  }
  const halted: boolean = body.halted;

  const group = await prisma.$transaction(async (tx) => {
    const updated = await tx.group.update({
      where: { id },
      data: { tradingHaltedAt: halted ? new Date() : null },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "GROUP_HALT_TOGGLED",
        entityType: "Group",
        entityId: id,
        oldValue: { tradingHalted: existing.tradingHaltedAt != null },
        newValue: { tradingHalted: halted },
      },
    });
    return updated;
  });

  return NextResponse.json({
    id: group.id,
    tradingHalted: group.tradingHaltedAt != null,
    tradingHaltedAt: group.tradingHaltedAt ? group.tradingHaltedAt.toISOString() : null,
  });
}
