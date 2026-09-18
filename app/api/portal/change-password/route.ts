import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getClientSession, revokeAllClientSessions } from "@/lib/client-auth";
import { checkRateLimit } from "@/lib/rate-limit";

// Client Portal counterpart to app/api/trade/change-password -- same
// current-password-verified, self-service shape, pointed at Client
// instead of Account.
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

  const client = await prisma.client.findUnique({ where: { id: session.clientId } });
  if (!client) {
    return NextResponse.json({ error: "client not found" }, { status: 404 });
  }

  const currentMatches = await bcrypt.compare(currentPassword, client.passwordHash);
  if (!currentMatches) {
    return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  await prisma.client.update({
    where: { id: client.id },
    data: { passwordHash: newPasswordHash },
  });
  // Evict every other session on a credential change (pentest 2026-09-18
  // #2); the session that made the change stays signed in.
  await revokeAllClientSessions(client.id, session.sessionId);

  return NextResponse.json({ ok: true });
}
