-- Step 3b item 3 (owner 2026-10-07): staff password change interval and the staff IP allowlist. Additive; every default keeps today's behaviour.
ALTER TABLE "Broker" ADD COLUMN "passwordMaxAgeDays" INTEGER;
ALTER TABLE "Broker" ADD COLUMN "staffIpAllowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AdminUser" ADD COLUMN "passwordChangedAt" TIMESTAMPTZ(3);
