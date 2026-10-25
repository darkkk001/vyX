-- Close and modify refusals in the rejected-order trace (owner 2026-10-23). Additive: existing rows are opens.
-- Revert: ALTER TABLE "RejectedOrder" DROP COLUMN "kind", DROP COLUMN "positionId", DROP COLUMN "clientReason", DROP COLUMN "lastTickAgeMs";
ALTER TABLE "RejectedOrder" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'OPEN', ADD COLUMN "positionId" TEXT, ADD COLUMN "clientReason" TEXT, ADD COLUMN "lastTickAgeMs" INTEGER;
