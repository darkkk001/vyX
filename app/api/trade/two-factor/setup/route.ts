import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { generateTotpSecret, totpUri } from "@/lib/totp";

// Generates a new secret and stores it, but leaves twoFactorEnabled
// false -- see Account.twoFactorEnabled's schema comment. Calling this
// again before confirming just overwrites the pending secret with a
// fresh one (e.g. the trader re-scans after a failed first attempt);
// nothing to migrate since nothing was ever active.
export async function POST() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const account = await prisma.account.findUnique({ where: { id: session.accountId } });
  if (!account) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const secret = generateTotpSecret();
  await prisma.account.update({ where: { id: account.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });

  const uri = totpUri(secret, account.accountNumber);
  const qrCodeDataUri = await QRCode.toDataURL(uri);

  return NextResponse.json({ secret, uri, qrCodeDataUri });
}
