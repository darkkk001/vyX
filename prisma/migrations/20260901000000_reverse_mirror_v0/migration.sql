-- Reverse mirror v0 (docs/briefs/VYX-MIRROR-V0-BRIEF.md). Schema is
-- permanent -- Phase 3 only rewires lib/mirror.ts's execution hook.

-- CreateEnum
CREATE TYPE "MirrorSource" AS ENUM ('GROUP', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "MirrorDirection" AS ENUM ('REVERSE', 'SAME');

-- CreateTable
CREATE TABLE "MirrorRule" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "sourceType" "MirrorSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetAccountId" TEXT NOT NULL,
    "direction" "MirrorDirection" NOT NULL DEFAULT 'REVERSE',
    "multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "symbolFilter" TEXT,
    "maxOpenLots" DECIMAL(10,2),
    "maxDailyLoss" DECIMAL(18,2),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "killedAt" TIMESTAMPTZ(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MirrorRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MirrorRule_brokerId_idx" ON "MirrorRule"("brokerId");

-- CreateIndex
CREATE INDEX "MirrorRule_sourceType_sourceId_idx" ON "MirrorRule"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "MirrorRule_targetAccountId_idx" ON "MirrorRule"("targetAccountId");

-- AddForeignKey
ALTER TABLE "MirrorRule" ADD CONSTRAINT "MirrorRule_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MirrorRule" ADD CONSTRAINT "MirrorRule_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MirrorRule" ADD CONSTRAINT "MirrorRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "MirrorLink" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "sourcePositionId" TEXT NOT NULL,
    "targetPositionId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MirrorLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MirrorLink_sourcePositionId_key" ON "MirrorLink"("sourcePositionId");

-- CreateIndex
CREATE UNIQUE INDEX "MirrorLink_targetPositionId_key" ON "MirrorLink"("targetPositionId");

-- CreateIndex
CREATE INDEX "MirrorLink_ruleId_idx" ON "MirrorLink"("ruleId");

-- AddForeignKey
ALTER TABLE "MirrorLink" ADD CONSTRAINT "MirrorLink_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "MirrorRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
