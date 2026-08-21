-- Two-factor authentication (TOTP, RFC 6238) for trader accounts. Null
-- secret / false enabled = 2FA not set up. See lib/totp.ts.
ALTER TABLE "Account" ADD COLUMN "twoFactorSecret" TEXT;
ALTER TABLE "Account" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
