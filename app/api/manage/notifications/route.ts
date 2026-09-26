import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveEntityLabels } from "@/lib/entity-labels";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { canReadAsManagerOrSupport } from "@/lib/permissions";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Phase 2 batch 4: the GET below is also open to the read-only SUPPORT role
// (lib/permissions.ts isSupportReader); every write in this file keeps requireManager.
async function requireReader() {
  const session = await getAdminSession();
  return canReadAsManagerOrSupport(session) ? session! : null;
}

export async function GET() {
  const session = await requireReader();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const notifications = await prisma.notification.findMany({
    where: { brokerId: session.brokerId! },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const entityLabels = await resolveEntityLabels(session.brokerId!, notifications.map((n) => ({ entityType: n.entityType, entityId: n.entityId })));
  return NextResponse.json(
    notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      entityType: n.entityType,
      entityId: n.entityId,
      entityLabel: entityLabels.get(n.entityId ?? "") ?? "",
      read: n.readAt != null,
      createdAt: n.createdAt.toISOString(),
    }))
  );
}

// Bulk mark-all-read -- shared read state, see Notification's schema comment.
export async function PATCH(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body?.markAllRead) {
    return NextResponse.json({ error: "markAllRead must be true" }, { status: 400 });
  }
  await prisma.notification.updateMany({
    where: { brokerId: session.brokerId!, readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
