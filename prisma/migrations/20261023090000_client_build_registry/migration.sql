-- Native-client build registry, durable copy (lib/client-builds.ts). Additive only: a new table, nothing else touched.
CREATE TABLE "ClientBuild" (
    "buildId" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "brokerSubdomain" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "note" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientBuild_pkey" PRIMARY KEY ("buildId")
);

CREATE INDEX "ClientBuild_brokerId_idx" ON "ClientBuild"("brokerId");
