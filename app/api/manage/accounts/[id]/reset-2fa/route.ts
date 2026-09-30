import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { revokeAllAccountSessions } from "@/lib/account-auth";

// Step 2 (owner 2026-09-30): CLI "Reset client 2FA". Clears the trading account's two-step sign-in (the client lost the
// phone) and signs it out everywhere, so the next sign-in is password-only and the client can set 2FA up again.
// BROKER_ADMIN only (a security change on the client's own login). Audited (ACCOUNT_2FA_RESET). 409 when the account
// has no two-step sign-in to reset.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true, brokerId: true, accountNumber: true, twoFactorEnabled: true, twoFactorSecret: true } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }
  if (!account.twoFactorEnabled && !account.twoFactorSecret) {
    return NextResponse.json({ error: "this account has no two-step sign-in to reset" }, { status: 409 });
  }
  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } }),
    prisma.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "ACCOUNT_2FA_RESET",
        entityType: "Account",
        entityId: account.id,
        oldValue: { twoFactorEnabled: account.twoFactorEnabled },
        newValue: { accountNumber: account.accountNumber, twoFactorEnabled: false },
      },
    }),
  ]);
  const revoked = await revokeAllAccountSessions(account.id);
  return NextResponse.json({ accountId: account.id, twoFactorEnabled: false, revoked });
}
