import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification || notification.type !== "ADMIN_PASSWORD_RESET_REQUESTED") {
    return NextResponse.json({ error: "notification not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (body?.read !== true) {
    return NextResponse.json({ error: "read must be true" }, { status: 400 });
  }

  await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  return NextResponse.json({ ok: true });
}
