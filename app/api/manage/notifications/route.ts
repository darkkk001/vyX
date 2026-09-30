import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveEntityLabels } from "@/lib/entity-labels";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { canReadAsManagerOrSupport } from "@/lib/permissions";
import { unreadStaffNotificationsFor } from "@/lib/notification-read";

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

  // Phase 2 batch 6 (issues 145 / 146): staff rows only -- a trader-copy row (accountId set: MARGIN_CALL, MARGIN_CALL_CLEARED,
  // price alerts ...) belongs to the trader's own inbox; the staff copy of the same event has no accountId
  const notifications = await prisma.notification.findMany({
    where: { brokerId: session.brokerId!, accountId: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    // web3 (issues.md 324): the caller's own read mark only
    include: { reads: { where: { adminId: session.adminId }, select: { readAt: true } } },
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
      // web3: read FOR THE CALLER -- their own mark, or the older shared / "handled for everyone" readAt
      read: n.readAt != null || n.reads.length > 0,
      createdAt: n.createdAt.toISOString(),
    }))
  );
}

// Bulk mark-all-read FOR THE CALLER only (web3, issues.md 324): writes the caller's own NotificationRead rows for every
// staff notification they have not read; nobody else's read state changes. One audit row with the count.
export async function PATCH(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body?.markAllRead) {
    return NextResponse.json({ error: "markAllRead must be true" }, { status: 400 });
  }
  const brokerId = session.brokerId!;
  const marked = await prisma.$transaction(async (tx) => {
    const unread = await tx.notification.findMany({ where: unreadStaffNotificationsFor(brokerId, session.adminId), select: { id: true } });
    if (unread.length === 0) return 0;
    const r = await tx.notificationRead.createMany({ data: unread.map((n) => ({ notificationId: n.id, adminId: session.adminId })), skipDuplicates: true });
    await tx.auditLog.create({
      data: { brokerId, actorAdminId: session.adminId, action: "NOTIFICATIONS_MARKED_ALL_READ", entityType: "AdminUser", entityId: session.adminId, newValue: { count: r.count } },
    });
    return r.count;
  });
  return NextResponse.json({ ok: true, marked });
}
