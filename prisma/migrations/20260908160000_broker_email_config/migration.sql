-- AlterTable
-- Per-broker transactional email config -- see lib/email/adapter.ts's
-- sendBrokerEmail. emailEnabled defaults false and the address fields
-- default null, so every existing broker keeps sending through the Mock
-- adapter (logged only) until explicitly configured; zero behavior
-- change for any broker until this is set.
ALTER TABLE "Broker" ADD COLUMN "emailFromDomain" TEXT;
ALTER TABLE "Broker" ADD COLUMN "emailFromAddress" TEXT;
ALTER TABLE "Broker" ADD COLUMN "emailFromName" TEXT;
ALTER TABLE "Broker" ADD COLUMN "emailEnabled" BOOLEAN NOT NULL DEFAULT false;
