import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { verifyTotp } from "@/lib/totp";
import { checkRateLimit } from "@/lib/rate-limit";

// Proves the trader actually scanned the QR / entered the secret
// correctly before 2FA starts gating their login -- see
// Account.twoFactorEnabled's schema comment.
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { allowed } = await checkRateLimit(`2fa-confirm:${session.accountId}`, 10, 300);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";

  const account = await prisma.account.findUnique({ where: { id: session.accountId } });
  if (!account?.twoFactorSecret) {
    return NextResponse.json({ error: "no 2FA setup in progress" }, { status: 409 });
  }
  if (account.twoFactorEnabled) {
    return NextResponse.json({ error: "2FA is already enabled" }, { status: 409 });
  }

  if (!verifyTotp(account.twoFactorSecret, code)) {
    return NextResponse.json({ error: "invalid code" }, { status: 401 });
  }

  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: { twoFactorEnabled: true } }),
    prisma.auditLog.create({
      data: {
        brokerId: account.brokerId,
        action: "WEBTRADER_2FA_ENABLED",
        entityType: "Account",
        entityId: account.id,
        oldValue: {},
        newValue: {},
      },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
