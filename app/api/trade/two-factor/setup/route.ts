import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { generateTotpSecret, totpUri } from "@/lib/totp";

// Generates a new secret and stores it, but leaves twoFactorEnabled
// false -- see Account.twoFactorEnabled's schema comment. Calling this
// again before confirming just overwrites the pending secret with a
// fresh one (e.g. the trader re-scans after a failed first attempt);
// nothing to migrate since nothing was ever active.
//
// Security fix: this used to unconditionally set twoFactorEnabled:
// false even when 2FA was ALREADY on, with no password check -- anyone
// holding a hijacked session could silently disarm 2FA through this
// route alone, bypassing /disable's whole reason for requiring a
// password. Same fix as the admin twin (app/api/admin/two-factor/setup) --
// only re-setup on an already-enabled account needs the password;
// first-time setup is unaffected.
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const account = await prisma.account.findUnique({ where: { id: session.accountId } });
  if (!account) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  if (account.twoFactorEnabled) {
    const body = await request.json().catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    const passwordMatches = await bcrypt.compare(password, account.passwordHash);
    if (!passwordMatches) {
      return NextResponse.json({ error: "re-enter your password to replace an existing 2FA setup" }, { status: 401 });
    }
  }

  const secret = generateTotpSecret();
  await prisma.account.update({ where: { id: account.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });

  const uri = totpUri(secret, account.accountNumber);
  const qrCodeDataUri = await QRCode.toDataURL(uri);

  return NextResponse.json({ secret, uri, qrCodeDataUri });
}
