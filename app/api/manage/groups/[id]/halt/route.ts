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

  // Either switch, on its own: {halted} is the full stop, {closeOnly} lets this
  // group close but not open (2026-09-23, so the dealing desk's own emergency
  // controls can be scoped to its group instead of the whole broker).
  const body = await request.json().catch(() => null);
  const hasHalted = typeof body?.halted === "boolean";
  const hasCloseOnly = typeof body?.closeOnly === "boolean";
  if (!hasHalted && !hasCloseOnly) {
    return NextResponse.json({ error: "halted and/or closeOnly must be a boolean" }, { status: 400 });
  }
  const halted: boolean = hasHalted ? body.halted : existing.tradingHaltedAt != null;
  const closeOnly: boolean = hasCloseOnly ? body.closeOnly : existing.closeOnlyAt != null;

  const group = await prisma.$transaction(async (tx) => {
    const updated = await tx.group.update({
      where: { id },
      data: {
        ...(hasHalted ? { tradingHaltedAt: halted ? new Date() : null } : {}),
        ...(hasCloseOnly ? { closeOnlyAt: closeOnly ? new Date() : null } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: hasHalted ? "GROUP_HALT_TOGGLED" : "GROUP_CLOSE_ONLY_TOGGLED",
        entityType: "Group",
        entityId: id,
        oldValue: { tradingHalted: existing.tradingHaltedAt != null, closeOnly: existing.closeOnlyAt != null },
        newValue: { ...(hasHalted ? { tradingHalted: halted } : {}), ...(hasCloseOnly ? { closeOnly } : {}) },
      },
    });
    return updated;
  });

  return NextResponse.json({
    id: group.id,
    tradingHalted: group.tradingHaltedAt != null,
    tradingHaltedAt: group.tradingHaltedAt ? group.tradingHaltedAt.toISOString() : null,
    closeOnly: group.closeOnlyAt != null,
    closeOnlyAt: group.closeOnlyAt ? group.closeOnlyAt.toISOString() : null,
  });
}
