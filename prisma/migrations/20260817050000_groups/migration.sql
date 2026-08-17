-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "leverage" INTEGER NOT NULL DEFAULT 100,
    "marginCallLevel" DECIMAL(6,2) NOT NULL DEFAULT 100,
    "stopOutLevel" DECIMAL(6,2) NOT NULL DEFAULT 50,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Group_brokerId_idx" ON "Group"("brokerId");

-- CreateIndex
CREATE UNIQUE INDEX "Group_brokerId_name_key" ON "Group"("brokerId", "name");

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "groupId" TEXT;

-- CreateIndex
CREATE INDEX "Account_groupId_idx" ON "Account"("groupId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
