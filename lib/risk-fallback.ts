import "server-only";
import { prisma } from "@/lib/prisma";

// Stage 6 (owner decision b, 2026-10-07): the web's 1-minute fallback while any broker is on the engine (RUST).
//
// The 5-minute margin-monitor cron stays as it was (WEB-only operation is unchanged). A second schedule, every minute,
// calls /api/internal/risk-fallback, which does the full web pass ONLY when all of these hold:
//   1. trading is active: the engine's own book gate says something the book holds can move (asked of the engine over
//      HTTP, no database), or the gate cannot be read (engine unreachable: that is when the fallback matters most);
//   2. at least one broker has riskAuthority = RUST (anyBrokerRust, cached below);
//   3. the engine's heartbeat is stale (readEngineHeartbeat): while it is fresh the engine acts, and the web's other
//      triggers (the engine's own 5 s backstop, the 5-minute cron) cover the accounts the web owns.
// Otherwise it returns without evaluating anything. With a stale heartbeat every RUST account is WEB-owned (the watchdog,
// docs/STAGE6-PLAN.md section 14), so this pass is the "web takes over" within a minute of N + the cron's phase, instead
// of the 5-minute cron's worst case.
//
// Neon: the order of the checks is the point. A quiet market (weekend, feed down while the engine answers "idle") returns
// at step 1 with no database read at all, exactly like the 5-minute cron's idle gate. Step 2 is one indexed read per
// instance per cache window (RUST_CACHE_MS): while NO broker is RUST it is repeated at most every 2 minutes per warm
// serverless instance, only while trading is active (when the database is awake anyway: the engine's shadow, the
// hook calls and the 5-minute cron are all reading it). Step 3 costs one read of one row, only while a broker is RUST,
// when the engine's own beats keep the database awake as well. So the fallback does not hold Neon open on its own.

/** How long an answer of "is any broker RUST" is reused by one server instance. A flip to RUST is noticed within this long. */
export const RUST_CACHE_MS = { none: 120_000, some: 30_000 } as const;

let cache: { value: boolean; at: number } | null = null;

/** Test hook: forget the cached answer. */
export function resetRiskFallbackCache(): void {
  cache = null;
}

/** Is any broker on the engine? Cached; a missing column (Stage 6 migration not applied yet) answers false. */
export async function anyBrokerRust(now = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < (cache.value ? RUST_CACHE_MS.some : RUST_CACHE_MS.none)) return cache.value;
  let value = false;
  try {
    const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM "Broker" WHERE "riskAuthority" = 'RUST'::"RiskAuthority" LIMIT 1`;
    value = rows.length > 0;
  } catch (err) {
    console.error("risk-fallback: could not read Broker.riskAuthority (migration not applied?): treated as no broker on the engine", err);
  }
  cache = { value, at: now };
  return value;
}

export type EngineHeartbeat = {
  present: boolean;
  alive: boolean;
  ageSecs: number | null;
  staleAfterSecs: number | null;
  engineVersion: string | null;
  instance: string | null;
};

/** The engine's heartbeat by the DATABASE clock (the one both sides judge by): alive = younger than staleAfterSecs. No row = not alive. Throws when the
 *  database cannot be read: the caller must not take "unreadable" for "stale" (it would alert about the engine for a database problem). */
export async function readEngineHeartbeat(): Promise<EngineHeartbeat> {
  const rows = await prisma.$queryRaw<{ ageSecs: number; staleAfterSecs: number; engineVersion: string | null; instance: string | null }[]>`
    SELECT extract(epoch FROM clock_timestamp() - "beatAt")::float8 AS "ageSecs", "staleAfterSecs", "engineVersion", instance FROM "RiskEngineHeartbeat" WHERE name = 'risk'`;
  const r = rows[0];
  if (!r) return { present: false, alive: false, ageSecs: null, staleAfterSecs: null, engineVersion: null, instance: null };
  return { present: true, alive: r.ageSecs <= r.staleAfterSecs, ageSecs: r.ageSecs, staleAfterSecs: r.staleAfterSecs, engineVersion: r.engineVersion, instance: r.instance };
}
