import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification || notification.brokerId !== session!.brokerId || notification.accountId !== null) {
    return NextResponse.json({ error: "notification not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (body?.read !== true) {
    return NextResponse.json({ error: "read must be true" }, { status: 400 });
  }

  // web3 (issues.md 324): marks it read for the CALLER only (their own NotificationRead row; idempotent), audited.
  // Nobody else's read state changes.
  const already = notification.readAt != null || (await prisma.notificationRead.findUnique({ where: { notificationId_adminId: { notificationId: id, adminId: session!.adminId } } })) != null;
  if (!already) {
    await prisma.$transaction([
      prisma.notificationRead.create({ data: { notificationId: id, adminId: session!.adminId } }),
      prisma.auditLog.create({
        data: { brokerId: session!.brokerId!, actorAdminId: session!.adminId, action: "NOTIFICATION_MARKED_READ", entityType: "Notification", entityId: id, newValue: { type: notification.type, title: notification.title } },
      }),
    ]);
  }
  return NextResponse.json({ ok: true });
}
