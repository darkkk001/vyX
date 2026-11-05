import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withConfigEvent } from "@/lib/config-events";
import { resetHmrCache } from "@/lib/hmr";
import { forbidden, parseWindowFields, requireHmrAdmin, windowDto } from "@/lib/hmr-admin";

// POST: add an HMR window (currency, startsAt / endsAt as UTC instants, leverage, enabled). The windows list is part of GET .../hmr.
async function postHandler(request: NextRequest) {
  const session = await requireHmrAdmin();
  if (!session) return forbidden();
  const brokerId = session.brokerId!;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "bad request" }, { status: 400 });
  const parsed = parseWindowFields(body as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const w = await prisma.$transaction(async (tx) => {
    const created = await tx.hmrWindow.create({ data: { brokerId, ...parsed.value, createdBy: session.adminId } });
    await tx.auditLog.create({
      data: { brokerId, actorAdminId: session.adminId, action: "HMR_WINDOW_CREATED", entityType: "HmrWindow", entityId: created.id, newValue: { ...windowDto(created) } },
    });
    return created;
  });
  resetHmrCache(brokerId);
  return NextResponse.json(windowDto(w), { status: 201 });
}

export const POST = withConfigEvent("settings", postHandler);
