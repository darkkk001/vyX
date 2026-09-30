import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { revokeAllAccountSessions } from "@/lib/account-auth";

// Step 2 (owner 2026-09-30): CLI "Force sign-out". Ends every session of one trading account now (the WebTrader and
// desktop terminal have to sign in again). MANAGER or BROKER_ADMIN: the same gate as accounts/[id]/reset-password,
// which already revokes every session as a side effect -- this is that revoke on its own, without a password change.
// SUPPORT (read-only) gets 403. Audited (ACCOUNT_SESSIONS_REVOKED) before the revoke, so the trail exists even if
// Redis is down.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true, brokerId: true, accountNumber: true } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }
  await prisma.auditLog.create({
    data: { brokerId, actorAdminId: session!.adminId, action: "ACCOUNT_SESSIONS_REVOKED", entityType: "Account", entityId: account.id, newValue: { accountNumber: account.accountNumber } },
  });
  const revoked = await revokeAllAccountSessions(account.id);
  return NextResponse.json({ accountId: account.id, revoked });
}
