import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAdminSession, listAdminSessions, revokeSessionById } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

// Phase 2 batch 4: an admin changes their OWN password (current password
// required). Needed once a BROKER_ADMIN can hand a staff member a one-time
// temporary password (POST /api/manage/admins/[id]/reset-password) -- before
// this there was no way at all for an admin to replace a password. Every
// OTHER session of this admin is revoked (the one making the change stays);
// audited. Self-service, open to every admin role.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { allowed } = await checkRateLimit(`admin-change-password:${session.adminId}`, 5, 300);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < 8) {
    return NextResponse.json({ error: "the new password must be at least 8 characters" }, { status: 400 });
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ error: "the new password must differ from the current one" }, { status: 400 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { id: session.adminId }, select: { id: true, brokerId: true, passwordHash: true } });
  if (!admin) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  if (!(await bcrypt.compare(currentPassword, admin.passwordHash))) {
    return NextResponse.json({ error: "incorrect current password" }, { status: 401 });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } }),
    prisma.auditLog.create({
      data: {
        brokerId: admin.brokerId,
        actorAdminId: admin.id,
        action: "ADMIN_PASSWORD_CHANGED",
        entityType: "AdminUser",
        entityId: admin.id,
        newValue: {},
      },
    }),
  ]);

  let revokedSessions = 0;
  for (const s of await listAdminSessions(admin.id, session.sessionId)) {
    if (!s.current && (await revokeSessionById(admin.id, s.sessionId))) revokedSessions++;
  }
  return NextResponse.json({ ok: true, revokedSessions });
}
