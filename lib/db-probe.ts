import "server-only";
import { PrismaClient } from "@prisma/client";

// The web's own book-database probe for GET /api/health (incident 2026-10-27 11:02-11:30 UTC: the database refused every
// NEW connection for 28 minutes and every health check stayed green). The engine and the gateway have the same probe
// (engine/server/src/db_probe.rs, services/api-gateway/src/db-probe.ts); deploy/db-health-runbook.md.
//
// - A NEW client and connection on DATABASE_URL each time (what a cold instance does), SELECT 1, within
//   PROBE_TIMEOUT_MS (5 s, not the engine's 2 s: a new Prisma client loads its query engine first; measured 1.55 s
//   PC -> Neon Frankfurt for the whole attempt, far less from fra1). The shared `prisma` client is never used: a warm instance's open connections keep working after a
//   password change, which is exactly what hid the incident.
// - On demand (serverless: no background loop), the result cached CACHE_MS per instance; concurrent requests share one
//   probe. Nothing in the app calls /api/health on a timer: the VPS check (deploy/vps/db-health-check.ps1) asks it only
//   while the engine's idle gate is open, so Neon still suspends when quiet.
// - console.error on the first failure an instance sees, again every LOG_REPEAT_MS while it lasts, console.warn when back.

export const PROBE_TIMEOUT_MS = 5_000;
export const CACHE_MS = 10_000;
export const LOG_REPEAT_MS = 60_000;

export type DbFailure = "auth" | "unreachable" | "timeout" | "error";
export type DbProbe = { ok: true } | { ok: false; reason: DbFailure; downSecs: number };

export function classifyDbError(e: unknown): DbFailure {
  const err = e as { errorCode?: string; code?: string; message?: string };
  const code = err?.errorCode ?? err?.code ?? "";
  const msg = err?.message ?? "";
  if (code === "P1000" || code === "28P01" || /password authentication failed|authentication failed/i.test(msg)) return "auth";
  if (code === "P1002" || code === "P2024" || /timed out|timeout/i.test(msg)) return "timeout";
  if (code === "P1001" || code === "P1017" || /can't reach database server|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) return "unreachable";
  return "error";
}

/** One attempt: a NEW client (and connection), SELECT 1, disconnected again; null = good. */
export async function attemptFreshConnection(url: string | undefined, timeoutMs = PROBE_TIMEOUT_MS): Promise<DbFailure | null> {
  if (!url) return "error";
  const client = new PrismaClient({ datasourceUrl: url, log: [] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.$queryRawUnsafe("SELECT 1"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("probe timeout"), { probeTimeout: true })), timeoutMs);
      }),
    ]);
    return null;
  } catch (e) {
    return (e as { probeTimeout?: boolean })?.probeTimeout ? "timeout" : classifyDbError(e);
  } finally {
    clearTimeout(timer);
    client.$disconnect().catch(() => {});
  }
}

type State = { at: number; result: DbFailure | null } | null;
let cached: State = null;
let inflight: Promise<DbFailure | null> | null = null;
let downSince: number | null = null;
let lastLog: number | null = null;

/** Test hook: forget this instance's cache and incident. */
export function resetDbProbe() {
  cached = null;
  inflight = null;
  downSince = null;
  lastLog = null;
}

export async function probeDatabase(
  opts: { now?: number; attempt?: () => Promise<DbFailure | null> } = {}
): Promise<DbProbe> {
  const now = opts.now ?? Date.now();
  if (!cached || now - cached.at >= CACHE_MS) {
    if (!inflight) {
      inflight = (opts.attempt ?? (() => attemptFreshConnection(process.env.DATABASE_URL)))().finally(() => {
        inflight = null;
      });
    }
    const result = await inflight;
    cached = { at: now, result };
    if (result === null) {
      if (downSince !== null) console.warn(`DB PROBE: the book database accepts new connections again after ${Math.round((now - downSince) / 1000)} s`);
      downSince = null;
    } else {
      if (downSince === null) {
        downSince = now;
        lastLog = now;
        console.error(`DB PROBE: the book database refuses NEW connections (${result}): /api/health answers 503`);
      } else if (lastLog === null || now - lastLog >= LOG_REPEAT_MS) {
        lastLog = now;
        console.error(`DB PROBE: still down (${result}) for ${Math.round((now - downSince) / 1000)} s`);
      }
    }
  }
  const r = cached.result;
  return r === null ? { ok: true } : { ok: false, reason: r, downSecs: Math.round((now - (downSince ?? now)) / 1000) };
}
