-- Durable per-login IP record (Risk Radar same-IP-multi-account pass).
-- Login IP was already captured (app/api/trade/login/route.ts's own
-- x-forwarded-for read) but only ever written into Redis session
-- metadata, which expires with the session's own TTL -- no durable,
-- indexed, cross-account-queryable record existed. Hand-picked from
-- `prisma migrate diff` against the live DB -- NOT applied verbatim,
-- same reasoning as every other migration in this project (see the
-- economic_calendar_cache migration's own comment).

-- CreateTable
CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginEvent_brokerId_ipAddress_createdAt_idx" ON "LoginEvent"("brokerId", "ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "LoginEvent_accountId_createdAt_idx" ON "LoginEvent"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
