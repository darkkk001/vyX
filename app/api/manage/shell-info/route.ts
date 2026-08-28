import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Everything app/manage/(shell)/layout.tsx's Server Component fetches to
// build the sidebar (broker name/logo, signed-in admin's email/role,
// unread notification count) -- exposed as JSON so a bundled desktop
// shell (manager-shell/, which has no Server Component of its own) can
// build the same sidebar. The website keeps using its own server-side
// fetch unchanged; this is additive, not a replacement.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [broker, admin, unreadNotifications] = await Promise.all([
    prisma.broker.findUnique({ where: { id: session!.brokerId! }, select: { name: true, logoUrl: true } }),
    prisma.adminUser.findUnique({ where: { id: session!.adminId }, select: { email: true } }),
    prisma.notification.count({ where: { brokerId: session!.brokerId!, readAt: null } }),
  ]);

  return NextResponse.json({
    brokerName: broker?.name ?? "Backoffice",
    brokerLogoUrl: broker?.logoUrl ?? null,
    adminEmail: admin?.email ?? null,
    role: session!.role,
    unreadNotifications,
  });
}
