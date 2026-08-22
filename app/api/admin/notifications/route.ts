import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Mirrors app/api/manage/notifications, scoped to Super Admin's own
// notification type instead of a single broker -- Notification.brokerId
// exists on every row (it's the broker the requesting admin belongs to,
// for display context), but this deliberately queries across all
// brokers by type rather than filtering to one, since Super Admin has
// no single broker of its own.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const notifications = await prisma.notification.findMany({
    where: { type: "ADMIN_PASSWORD_RESET_REQUESTED" },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { broker: { select: { name: true } } },
  });

  return NextResponse.json(
    notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      brokerName: n.broker.name,
      entityType: n.entityType,
      entityId: n.entityId,
      read: n.readAt != null,
      createdAt: n.createdAt.toISOString(),
    }))
  );
}

export async function PATCH(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body?.markAllRead) {
    return NextResponse.json({ error: "markAllRead must be true" }, { status: 400 });
  }
  await prisma.notification.updateMany({
    where: { type: "ADMIN_PASSWORD_RESET_REQUESTED", readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
