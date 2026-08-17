-- CreateEnum
CREATE TYPE "ExecutionEngine" AS ENUM ('LEGACY', 'RUST');

-- AlterTable
-- Additive, defaulted column -- safe regardless of existing Broker rows.
-- Currently decorative: no app/api/trade/* route reads this yet, see
-- ExecutionEngine's schema comment / ADR-003.
ALTER TABLE "Broker" ADD COLUMN "executionEngine" "ExecutionEngine" NOT NULL DEFAULT 'LEGACY';
