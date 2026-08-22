-- Two-factor authentication (TOTP, RFC 6238) for AdminUser -- mirrors
-- 20260821140000_two_factor_auth's Account columns. Null secret / false
-- enabled = 2FA not set up. See lib/totp.ts.
ALTER TABLE "AdminUser" ADD COLUMN "twoFactorSecret" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
