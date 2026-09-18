import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAccountSession, revokeAllAccountSessions } from "@/lib/account-auth";

export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (newPassword.length < 8) {
    return NextResponse.json({ error: "new password must be at least 8 characters" }, { status: 400 });
  }

  const account = await prisma.account.findUnique({ where: { id: session.accountId } });
  if (!account) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const currentMatches = await bcrypt.compare(currentPassword, account.passwordHash);
  if (!currentMatches) {
    return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  await prisma.account.update({
    where: { id: account.id },
    data: { passwordHash: newPasswordHash },
  });
  // A changed password must evict every OTHER session (pentest 2026-09-18
  // #2: before this, a stolen cookie survived the victim's password change
  // for its full TTL). The session that made the change stays signed in.
  await revokeAllAccountSessions(account.id, session.sessionId);

  return NextResponse.json({ ok: true });
}
