import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Everything app/(super-admin)/(shell)/layout.tsx's Server Component
// fetches to build the sidebar (signed-in admin's email, pending
// password-reset notification count) -- exposed as JSON so a bundled
// admin-shell desktop app (no Server Component of its own) can build
// the same sidebar. The website keeps its own server-side fetch
// unchanged; this is additive.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [admin, unreadNotifications] = await Promise.all([
    prisma.adminUser.findUnique({ where: { id: session!.adminId }, select: { email: true } }),
    prisma.notification.count({ where: { type: "ADMIN_PASSWORD_RESET_REQUESTED", readAt: null } }),
  ]);

  return NextResponse.json({
    adminEmail: admin?.email ?? null,
    unreadNotifications,
  });
}
