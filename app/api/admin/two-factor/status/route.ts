import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Same data app/(super-admin)/(shell)/security/page.tsx's Server
// Component used to fetch inline -- exposed as JSON so SecurityManager
// can fetch it itself (both the website and a bundled admin-shell
// desktop app use this one path now).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id: session!.adminId },
    select: { twoFactorEnabled: true },
  });

  return NextResponse.json({ enabled: admin?.twoFactorEnabled ?? false });
}
