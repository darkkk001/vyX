import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { generateTotpSecret, totpUri } from "@/lib/totp";

// Mirrors app/api/trade/two-factor/setup exactly, scoped to SUPER_ADMIN
// (see AdminUser.twoFactorSecret's schema comment) -- generates a new
// secret and stores it, but leaves twoFactorEnabled false until POST
// .../confirm proves it was actually scanned. Calling this again before
// confirming just overwrites the pending secret with a fresh one.
export async function POST() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { id: session!.adminId } });
  if (!admin) {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }

  const secret = generateTotpSecret();
  await prisma.adminUser.update({ where: { id: admin.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });

  const uri = totpUri(secret, admin.email, "VyXTrader Super Admin");
  const qrCodeDataUri = await QRCode.toDataURL(uri);

  return NextResponse.json({ secret, uri, qrCodeDataUri });
}
