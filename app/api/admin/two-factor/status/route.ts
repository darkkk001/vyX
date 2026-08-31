import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Same data app/(super-admin)/(shell)/security/page.tsx's Server
// Component used to fetch inline -- exposed as JSON so SecurityManager
// can fetch it itself (both the website and a bundled admin-shell
// desktop app use this one path now). Phase 1 trust pack: widened from
// SUPER_ADMIN-only (see .../setup's own comment) -- also now used by
// app/manage/(shell)/security's own SecurityManager instance. Includes
// how many backup codes are left unused so the UI can nudge a
// regenerate when it's running low, without exposing the codes
// themselves (write-once, see .../confirm's own comment).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN", "MANAGER", "BROKER_ADMIN", "SUPPORT"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id: session!.adminId },
    select: { twoFactorEnabled: true },
  });
  const unusedBackupCodes = admin?.twoFactorEnabled
    ? await prisma.adminBackupCode.count({ where: { adminId: session!.adminId, usedAt: null } })
    : 0;

  return NextResponse.json({ enabled: admin?.twoFactorEnabled ?? false, unusedBackupCodes });
}
