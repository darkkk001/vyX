-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "fullName" TEXT NOT NULL,
    "country" TEXT,
    "phone" TEXT,
    "dateOfBirth" DATE,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientKycRecord" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "documentType" TEXT NOT NULL,
    "documentFrontUrl" TEXT NOT NULL,
    "documentBackUrl" TEXT,
    "addressProofUrl" TEXT,
    "rejectionReason" TEXT,
    "reviewedByAdminId" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ClientKycRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveAccountRequest" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountTypeId" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedByAdminId" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAccountId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveAccountRequest_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- 2026-09-08 -- was @@unique([brokerId, email, accountMode]), capping a
-- client at exactly one DEMO and one LIVE account per broker. clientId is
-- now the real ownership link; accountNumber's own unique constraint
-- already prevents any actual duplicate account.
DROP INDEX IF EXISTS "Account_brokerId_email_accountMode_key";
ALTER TABLE "Account" ADD COLUMN "clientId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Client_brokerId_email_key" ON "Client"("brokerId", "email");

-- CreateIndex
CREATE INDEX "Client_brokerId_idx" ON "Client"("brokerId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientKycRecord_clientId_key" ON "ClientKycRecord"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveAccountRequest_createdAccountId_key" ON "LiveAccountRequest"("createdAccountId");

-- CreateIndex
CREATE INDEX "LiveAccountRequest_brokerId_idx" ON "LiveAccountRequest"("brokerId");

-- CreateIndex
CREATE INDEX "LiveAccountRequest_clientId_idx" ON "LiveAccountRequest"("clientId");

-- CreateIndex
CREATE INDEX "Account_clientId_idx" ON "Account"("clientId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientKycRecord" ADD CONSTRAINT "ClientKycRecord_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientKycRecord" ADD CONSTRAINT "ClientKycRecord_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveAccountRequest" ADD CONSTRAINT "LiveAccountRequest_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveAccountRequest" ADD CONSTRAINT "LiveAccountRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveAccountRequest" ADD CONSTRAINT "LiveAccountRequest_accountTypeId_fkey" FOREIGN KEY ("accountTypeId") REFERENCES "AccountType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveAccountRequest" ADD CONSTRAINT "LiveAccountRequest_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveAccountRequest" ADD CONSTRAINT "LiveAccountRequest_createdAccountId_fkey" FOREIGN KEY ("createdAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
