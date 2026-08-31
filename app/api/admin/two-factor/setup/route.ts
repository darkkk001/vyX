import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { generateTotpSecret, totpUri } from "@/lib/totp";

// Mirrors app/api/trade/two-factor/setup exactly -- generates a new
// secret and stores it, but leaves twoFactorEnabled false until POST
// .../confirm proves it was actually scanned. Calling this again before
// confirming just overwrites the pending secret with a fresh one.
//
// Phase 1 trust pack -- widened from SUPER_ADMIN-only to every admin
// role. AdminUser.twoFactorSecret/twoFactorEnabled already existed for
// this (see that field's schema comment); this route, .../confirm,
// .../disable, and .../status were the only things that hardcoded who
// could reach them, not the underlying model. issuer is now the admin's
// own broker name when they have one, so a broker-scoped admin's
// authenticator app doesn't misleadingly say "Super Admin".
//
// Security fix (predates this widening): this used to unconditionally
// set twoFactorEnabled: false even when 2FA was ALREADY on, with no
// password check -- anyone holding a hijacked session could silently
// disarm 2FA through this route alone, completely bypassing /disable's
// whole reason for requiring a password. Now requires the same password
// re-entry disable does, but only when 2FA is already enabled --
// first-time setup (the overwhelmingly common call) is unaffected.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN", "MANAGER", "BROKER_ADMIN", "SUPPORT"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { id: session!.adminId } });
  if (!admin) {
    return NextResponse.json({ error: "admin not found" }, { status: 404 });
  }

  if (admin.twoFactorEnabled) {
    const body = await request.json().catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordMatches) {
      return NextResponse.json({ error: "re-enter your password to replace an existing 2FA setup" }, { status: 401 });
    }
  }

  const secret = generateTotpSecret();
  await prisma.adminUser.update({ where: { id: admin.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });

  const issuer = admin.brokerId
    ? (await prisma.broker.findUnique({ where: { id: admin.brokerId }, select: { name: true } }))?.name ?? "VyXTrader"
    : "VyXTrader Super Admin";
  const uri = totpUri(secret, admin.email, issuer);
  const qrCodeDataUri = await QRCode.toDataURL(uri);

  return NextResponse.json({ secret, uri, qrCodeDataUri });
}
