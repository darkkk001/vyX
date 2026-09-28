import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getClientSession, revokeAllClientSessions } from "@/lib/client-auth";
import { checkRateLimit } from "@/lib/rate-limit";

// Client Portal counterpart to app/api/trade/change-password -- same
// current-password-verified, self-service shape, pointed at Client
// instead of Account. Removed as orphaned in Phase 2 batch 6 (no screen called it); restored 2026-09-28 with the
// portal Profile screen that now does. Review changes against the e78cf58 original: a wrong current password is a
// 400 (a 401 reads as "signed out" to the portal), the new password must differ from the current one and be at
// most 72 bytes (bcrypt ignores anything past that), and the change writes a CLIENT_PASSWORD_CHANGED audit row
// (no values).
export async function POST(request: NextRequest) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { allowed } = await checkRateLimit(`portal-change-password:${session.clientId}`, 5, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (newPassword.length < 8) {
    return NextResponse.json({ error: "new password must be at least 8 characters" }, { status: 400 });
  }
  if (Buffer.byteLength(newPassword, "utf8") > 72) {
    return NextResponse.json({ error: "new password must be at most 72 characters" }, { status: 400 });
  }

  const client = await prisma.client.findUnique({ where: { id: session.clientId } });
  if (!client) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const currentMatches = await bcrypt.compare(currentPassword, client.passwordHash);
  if (!currentMatches) {
    return NextResponse.json({ error: "current password is incorrect" }, { status: 400 });
  }
  if (await bcrypt.compare(newPassword, client.passwordHash)) {
    return NextResponse.json({ error: "new password must be different from the current one" }, { status: 400 });
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction([
    prisma.client.update({ where: { id: client.id }, data: { passwordHash: newPasswordHash } }),
    prisma.auditLog.create({
      data: {
        brokerId: client.brokerId,
        actorAdminId: null,
        action: "CLIENT_PASSWORD_CHANGED",
        entityType: "Client",
        entityId: client.id,
        newValue: { changedBy: "client", email: client.email },
      },
    }),
  ]);
  // Evict every other session on a credential change (pentest 2026-09-18
  // #2); the session that made the change stays signed in.
  await revokeAllClientSessions(client.id, session.sessionId);

  return NextResponse.json({ ok: true });
}
