-- AlterEnum
-- Additive enum values -- safe regardless of existing Broker rows (every
-- current row is ACTIVE or SUSPENDED, both untouched). TRIAL is placed
-- before ACTIVE purely for readable ordering in tools that sort by enum
-- position; DISABLED is appended since it has no natural neighbor.
ALTER TYPE "BrokerStatus" ADD VALUE 'TRIAL' BEFORE 'ACTIVE';
ALTER TYPE "BrokerStatus" ADD VALUE 'DISABLED';

-- AlterTable
-- Additive, nullable columns -- safe regardless of existing Broker rows.
-- Config-only tenant lifecycle/billing fields, not wired to any payment
-- processor -- see lib/billing.ts and Broker.trialEndsAt/nextInvoiceAt's
-- own schema comments.
ALTER TABLE "Broker" ADD COLUMN     "trialEndsAt" TIMESTAMPTZ(3);
ALTER TABLE "Broker" ADD COLUMN     "nextInvoiceAt" TIMESTAMPTZ(3);
