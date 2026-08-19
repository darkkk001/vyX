-- Add basic identity/KYC fields to Account. Nullable: every existing
-- account (seeded demo data) has none of this, and there was previously
-- no way to enter it (no self-registration flow existed).
ALTER TABLE "Account" ADD COLUMN "country" TEXT;
ALTER TABLE "Account" ADD COLUMN "phone" TEXT;
ALTER TABLE "Account" ADD COLUMN "dateOfBirth" DATE;
