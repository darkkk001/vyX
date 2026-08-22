import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { generateTemporaryPassword } from "@/lib/passwords";

// Mirrors app/api/manage/accounts/[id]/reset-password -- the other end
// of a broker staff member's in-app "Forgot password?" (see
// app/api/admin/forgot-password), reached from the Notification it
// created (app/(super-admin)/(shell)/notifications).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const admin = await prisma.adminUser.findUnique({ where: { id } });
  if (!admin) {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }

  const password = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } }),
    prisma.auditLog.create({
      data: {
        brokerId: admin.brokerId,
        actorAdminId: session!.adminId,
        action: "ADMIN_PASSWORD_RESET_BY_SUPER_ADMIN",
        entityType: "AdminUser",
        entityId: admin.id,
        newValue: { email: admin.email },
      },
    }),
  ]);

  return NextResponse.json({ password });
}
