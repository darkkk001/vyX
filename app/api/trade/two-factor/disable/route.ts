import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { checkRateLimit } from "@/lib/rate-limit";

// Requires re-entering the current password -- same standard practice as
// disabling 2FA anywhere else -- so a trader who stepped away from an
// already-unlocked session can't have this security feature turned off
// by whoever's now at the keyboard.
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { allowed } = await checkRateLimit(`2fa-disable:${session.accountId}`, 10, 300);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  const account = await prisma.account.findUnique({ where: { id: session.accountId } });
  if (!account) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }
  if (!account.twoFactorEnabled) {
    return NextResponse.json({ error: "2FA is not enabled" }, { status: 409 });
  }

  const passwordMatches = await bcrypt.compare(password, account.passwordHash);
  if (!passwordMatches) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: { twoFactorSecret: null, twoFactorEnabled: false } }),
    prisma.auditLog.create({
      data: {
        brokerId: account.brokerId,
        action: "WEBTRADER_2FA_DISABLED",
        entityType: "Account",
        entityId: account.id,
        oldValue: {},
        newValue: {},
      },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
