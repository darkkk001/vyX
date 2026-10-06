import type { PrismaClient } from "@prisma/client";

// Test support for the Stage 6 engine-down watchdog (lib/risk-owner.ts, docs/STAGE6-PLAN.md section 14): sets the engine's heartbeat row
// (name 'risk') as a test wants it, by the DATABASE clock: the last beat `ageSecs` ago, stale after `staleAfterSecs` (default a year, so
// the tests of the ownership SPLIT are not about the watchdog). Pass `null` to delete the row (no heartbeat at all = stale).
export async function setRiskHeartbeat(prisma: Pick<PrismaClient, "$executeRaw">, ageSecs: number | null, staleAfterSecs = 31_536_000): Promise<void> {
  if (ageSecs === null) {
    await prisma.$executeRaw`DELETE FROM "RiskEngineHeartbeat" WHERE name = 'risk'`;
    return;
  }
  await prisma.$executeRaw`
    INSERT INTO "RiskEngineHeartbeat" (name, "beatAt", "staleAfterSecs") VALUES ('risk', clock_timestamp() - make_interval(secs => ${ageSecs}::float8), ${staleAfterSecs}::int)
    ON CONFLICT (name) DO UPDATE SET "beatAt" = clock_timestamp() - make_interval(secs => ${ageSecs}::float8), "staleAfterSecs" = ${staleAfterSecs}::int`;
}
