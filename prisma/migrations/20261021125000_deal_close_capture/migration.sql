-- D-3 (owner 2026-10-21): the execution capture of a close that goes through no Order (prisma/schema.prisma Deal).
-- Additive, no default: deals written before this stay NULL.
ALTER TABLE "Deal"
  ADD COLUMN "requestedAt" TIMESTAMPTZ(3),
  ADD COLUMN "requestedPrice" DECIMAL(18,5),
  ADD COLUMN "clientIp" TEXT,
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "routing" TEXT,
  ADD COLUMN "executionMode" TEXT;
