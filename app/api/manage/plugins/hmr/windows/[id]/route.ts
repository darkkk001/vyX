import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withConfigEvent } from "@/lib/config-events";
import { resetHmrCache } from "@/lib/hmr";
import { forbidden, parseWindowFields, requireHmrAdmin, windowDto } from "@/lib/hmr-admin";

type Ctx = { params: Promise<{ id: string }> };

// PATCH: change a window (any of currency, startsAt, endsAt, leverage, enabled). A change reaches NEW positions only: a position
// that opened under the window keeps the leverage it opened with (Position.openLeverage).
async function patchHandler(request: NextRequest, { params }: Ctx) {
  const session = await requireHmrAdmin();
  if (!session) return forbidden();
  const brokerId = session.brokerId!;
  const { id } = await params;
  const existing = await prisma.hmrWindow.findFirst({ where: { id, brokerId } });
  if (!existing) return NextResponse.json({ error: "window not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "bad request" }, { status: 400 });
  const parsed = parseWindowFields(body as Record<string, unknown>, existing);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const w = await prisma.$transaction(async (tx) => {
    const updated = await tx.hmrWindow.update({ where: { id }, data: parsed.value });
    await tx.auditLog.create({
      data: { brokerId, actorAdminId: session.adminId, action: "HMR_WINDOW_UPDATED", entityType: "HmrWindow", entityId: id, oldValue: { ...windowDto(existing) }, newValue: { ...windowDto(updated) } },
    });
    return updated;
  });
  resetHmrCache(brokerId);
  return NextResponse.json(windowDto(w));
}

async function deleteHandler(_request: NextRequest, { params }: Ctx) {
  const session = await requireHmrAdmin();
  if (!session) return forbidden();
  const brokerId = session.brokerId!;
  const { id } = await params;
  const existing = await prisma.hmrWindow.findFirst({ where: { id, brokerId } });
  if (!existing) return NextResponse.json({ error: "window not found" }, { status: 404 });
  await prisma.$transaction(async (tx) => {
    await tx.hmrWindow.delete({ where: { id } });
    await tx.auditLog.create({
      data: { brokerId, actorAdminId: session.adminId, action: "HMR_WINDOW_DELETED", entityType: "HmrWindow", entityId: id, oldValue: { ...windowDto(existing) } },
    });
  });
  resetHmrCache(brokerId);
  return NextResponse.json({ deleted: true });
}

export const PATCH = withConfigEvent("settings", patchHandler);
export const DELETE = withConfigEvent("settings", deleteHandler);
