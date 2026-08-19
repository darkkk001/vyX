import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const notifications = await prisma.notification.findMany({
    where: { brokerId: session.brokerId! },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json(
    notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      entityType: n.entityType,
      entityId: n.entityId,
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
