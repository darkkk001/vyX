-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_groupId_fkey";
-- AlterTable
ALTER TABLE "GroupSymbol" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);
-- AlterTable
ALTER TABLE "GroupSymbolConfig" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);
-- AlterTable
ALTER TABLE "MirrorRule" ALTER COLUMN "killedAt" SET DATA TYPE TIMESTAMP(3);
-- AlterTable
ALTER TABLE "RiskEngineHeartbeat" ALTER COLUMN "beatAt" SET DEFAULT CURRENT_TIMESTAMP;
-- AlterTable
ALTER TABLE "Transaction" ALTER COLUMN "updatedAt" DROP DEFAULT;
-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
