-- Step 3b item 5 (owner 2026-10-07): staff sign-in record (devices and IP addresses on Staff). New table only.
CREATE TABLE "AdminSignIn" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "brokerId" TEXT,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSignIn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminSignIn_adminId_createdAt_idx" ON "AdminSignIn"("adminId", "createdAt");

ALTER TABLE "AdminSignIn" ADD CONSTRAINT "AdminSignIn_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
