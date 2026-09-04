-- Dealer desk ON/OFF toggle -- see Broker.dealingDeskAutoFillAt's own
-- schema comment for full semantics. Hand-written, not `prisma migrate
-- dev` output -- same established convention as every other migration in
-- this history (the Rust engine's own snake_case tables always show up
-- as unrelated drift in a raw diff).

-- AlterTable
ALTER TABLE "Broker" ADD COLUMN "dealingDeskAutoFillAt" TIMESTAMPTZ(3);
