// Rotate (or disable) an admin account's password directly against the DB.
// Built for the 2026-09-15 super-admin audit: super@vyxtrader.com shipped with
// the repo's public seed password and no 2FA. Enrolling 2FA (in the UI) closes
// the login hole; this rotates the now-known password so it stops working at all.
//
// Usage (run where DATABASE_URL points at the LIVE DB, e.g. `vercel env pull`
// first, or paste it inline):
//   DATABASE_URL=... node scripts/rotate-admin-password.mjs super@vyxtrader.com
//   DATABASE_URL=... node scripts/rotate-admin-password.mjs super@vyxtrader.com --disable
//
// It prints the new password ONCE. Copy it into your password manager; it is
// never stored anywhere else. --disable also sets status DISABLED (combined with
// the app's per-request status check, that cuts every live session immediately).
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const email = (process.argv[2] || "").trim().toLowerCase();
const disable = process.argv.includes("--disable");
if (!email) {
  console.error("usage: node scripts/rotate-admin-password.mjs <email> [--disable]");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (point it at the live DB before running)");
  process.exit(1);
}

const prisma = new PrismaClient();
const newPassword = crypto.randomBytes(18).toString("base64url") + "aA1!";

try {
  const admin = await prisma.adminUser.findUnique({ where: { email }, select: { id: true, role: true, status: true } });
  if (!admin) {
    console.error(`no admin found for ${email}`);
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { passwordHash, ...(disable ? { status: "DISABLED" } : {}) },
  });
  console.log(`Rotated password for ${email} (role ${admin.role}${disable ? ", now DISABLED" : ""}).`);
  console.log(`New password (store it now, shown once): ${newPassword}`);
  console.log("Next: sign in and enrol 2FA immediately (the app now forces it for SUPER_ADMIN).");
} finally {
  await prisma.$disconnect();
}
