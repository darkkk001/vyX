-- Phase 1 trust pack §1 -- admin 2FA for MANAGER/BROKER_ADMIN/SUPPORT.
-- Reuses AdminUser.twoFactorSecret/twoFactorEnabled (already existed for
-- Super Admin) unchanged -- nothing new there, just widened who can use
-- them (app/api/admin/two-factor/* role checks). Two genuinely new
-- pieces: per-broker policy, and single-use backup codes (a feature
-- neither Super Admin nor trader 2FA had before this).
ALTER TABLE "Broker" ADD COLUMN "requireAdmin2fa" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AdminBackupCode" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminBackupCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminBackupCode_adminId_idx" ON "AdminBackupCode"("adminId");

ALTER TABLE "AdminBackupCode" ADD CONSTRAINT "AdminBackupCode_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
