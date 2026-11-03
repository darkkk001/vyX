-- Platform API bridge config, A.1.1 (owner decisions 2026-11-03; C:\vyx\handoff\platform-api-bridge-config-plan.md).
-- New tables only: the FIX session a QoreBridge opens to a liquidity provider (LpConnection) and how that session
-- trades each platform symbol (LpConnectionSymbol), so the bridge can take them from the platform (A.1.2) instead of
-- the [[lp]] / [[lp.symbol]] tables in qorebridge.toml. LpConnection.liquidityProviderId is the bridge's [[lp]] id.
-- Nothing existing changes: no column, no row, no rewrite. The new foreign keys take a brief lock on Broker,
-- LiquidityProvider and Symbol while they are added (the new tables are empty, so there is nothing to check).
-- Never stored here: the LP password (stays on the bridge server), a CA file path, raw-log settings.
-- The CHECKs repeat the bridge's own config validation (qorebridge bin/qorebridge/src/config.rs venue() and the
-- [[lp]] checks), so a row the bridge would refuse cannot be stored. Prisma does not model CHECKs: no schema drift.
-- Revert: DROP TABLE "LpConnectionSymbol"; DROP TABLE "LpConnection";
--         DROP TYPE "LpTlsMode"; DROP TYPE "LpConnectionRole"; DROP TYPE "LpDialect";
-- CreateEnum
CREATE TYPE "LpDialect" AS ENUM ('FIX44', 'CSERVER');

-- CreateEnum
CREATE TYPE "LpConnectionRole" AS ENUM ('TRADE', 'QUOTE');

-- CreateEnum
CREATE TYPE "LpTlsMode" AS ENUM ('OFF', 'WEBPKI', 'NATIVE');

-- CreateTable
CREATE TABLE "LpConnection" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "liquidityProviderId" TEXT NOT NULL,
    "role" "LpConnectionRole" NOT NULL DEFAULT 'TRADE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "senderCompId" TEXT NOT NULL,
    "targetCompId" TEXT NOT NULL,
    "senderSubId" TEXT,
    "targetSubId" TEXT,
    "username" TEXT,
    "tls" "LpTlsMode" NOT NULL,
    "tlsServerName" TEXT,
    "dialect" "LpDialect" NOT NULL DEFAULT 'FIX44',
    "heartbeatSecs" INTEGER NOT NULL DEFAULT 30,
    "resetSeqOnLogon" BOOLEAN NOT NULL DEFAULT false,
    "ackTimeoutMs" INTEGER,
    "orderTtlSecs" INTEGER,
    "maxAttempts" INTEGER,
    "reconcileTimeoutSecs" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LpConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LpConnectionSymbol" (
    "id" TEXT NOT NULL,
    "lpConnectionId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "contractSize" DECIMAL(18,4) NOT NULL,
    "minUnits" DECIMAL(18,4) NOT NULL,
    "stepUnits" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LpConnectionSymbol_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LpConnection_brokerId_idx" ON "LpConnection"("brokerId");

-- CreateIndex
CREATE UNIQUE INDEX "LpConnection_liquidityProviderId_role_key" ON "LpConnection"("liquidityProviderId", "role");

-- CreateIndex
CREATE INDEX "LpConnectionSymbol_symbolId_idx" ON "LpConnectionSymbol"("symbolId");

-- CreateIndex
CREATE UNIQUE INDEX "LpConnectionSymbol_lpConnectionId_symbolId_key" ON "LpConnectionSymbol"("lpConnectionId", "symbolId");

-- AddForeignKey
ALTER TABLE "LpConnection" ADD CONSTRAINT "LpConnection_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LpConnection" ADD CONSTRAINT "LpConnection_liquidityProviderId_fkey" FOREIGN KEY ("liquidityProviderId") REFERENCES "LiquidityProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LpConnectionSymbol" ADD CONSTRAINT "LpConnectionSymbol_lpConnectionId_fkey" FOREIGN KEY ("lpConnectionId") REFERENCES "LpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LpConnectionSymbol" ADD CONSTRAINT "LpConnectionSymbol_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CheckConstraints (the bridge's rules)
ALTER TABLE "LpConnection" ADD CONSTRAINT "LpConnection_session_check" CHECK (
  btrim("host") <> '' AND btrim("senderCompId") <> '' AND btrim("targetCompId") <> ''
  AND "port" BETWEEN 1 AND 65535
  AND "heartbeatSecs" > 0
);
ALTER TABLE "LpConnection" ADD CONSTRAINT "LpConnection_timeouts_check" CHECK (
  ("ackTimeoutMs" IS NULL OR "ackTimeoutMs" > 0)
  AND ("orderTtlSecs" IS NULL OR "orderTtlSecs" > 0)
  AND ("maxAttempts" IS NULL OR "maxAttempts" > 0)
  AND ("reconcileTimeoutSecs" IS NULL OR "reconcileTimeoutSecs" > 0)
);
ALTER TABLE "LpConnectionSymbol" ADD CONSTRAINT "LpConnectionSymbol_units_check" CHECK (
  btrim("venueId") <> ''
  AND "contractSize" > 0 AND "minUnits" > 0 AND "stepUnits" > 0
  AND mod("minUnits", "stepUnits") = 0
);
