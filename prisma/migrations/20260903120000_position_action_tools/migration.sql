-- Backoffice manual position tools (VYX-POSITION-TOOLS-V0): true soft-
-- delete for Position (deletedAt/deletedByAdminId/deleteReason -- see
-- Position's own schema comment) and the PositionActionRequest table
-- backing the MANAGER-needs-a-different-admin's-approval maker-checker
-- gate for REVERSE_IN_PLACE / REVERSE_CLOSE_REOPEN / VOID / DELETE (see
-- that model's own schema comment). Hand-picked from `prisma migrate diff`
-- against the live DB -- NOT applied verbatim, since that diff also
-- contained a pile of pre-existing, unrelated drift (the Rust engine's own
-- snake_case tables reading as "should be dropped," column-type nits on
-- GroupSymbol/GroupSymbolConfig/MirrorRule/Transaction) -- see this
-- project's own migrate-dev gotcha: never trust the raw diff wholesale on
-- this DB.

-- CreateEnum
CREATE TYPE "PositionActionType" AS ENUM ('REVERSE_IN_PLACE', 'REVERSE_CLOSE_REOPEN', 'VOID', 'DELETE');

-- CreateEnum
CREATE TYPE "PositionActionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "deletedByAdminId" TEXT;

-- CreateIndex
CREATE INDEX "Position_deletedAt_idx" ON "Position"("deletedAt");

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_deletedByAdminId_fkey" FOREIGN KEY ("deletedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "PositionActionRequest" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "actionType" "PositionActionType" NOT NULL,
    "status" "PositionActionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "requestedByAdminId" TEXT NOT NULL,
    "reviewedByAdminId" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PositionActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PositionActionRequest_brokerId_idx" ON "PositionActionRequest"("brokerId");

-- CreateIndex
CREATE INDEX "PositionActionRequest_positionId_idx" ON "PositionActionRequest"("positionId");

-- CreateIndex
CREATE INDEX "PositionActionRequest_status_idx" ON "PositionActionRequest"("status");

-- AddForeignKey
ALTER TABLE "PositionActionRequest" ADD CONSTRAINT "PositionActionRequest_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionActionRequest" ADD CONSTRAINT "PositionActionRequest_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionActionRequest" ADD CONSTRAINT "PositionActionRequest_requestedByAdminId_fkey" FOREIGN KEY ("requestedByAdminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionActionRequest" ADD CONSTRAINT "PositionActionRequest_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
