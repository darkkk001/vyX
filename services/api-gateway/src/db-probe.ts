// Book database probe (incident 2026-10-27 11:02-11:30 UTC: the neondb_owner password was reset, Neon refused every NEW
// connection for ~28 minutes and /health kept answering {ok:true}: it never touched the database, and the pool's open
// connections kept working). The engine has the same probe (engine/server/src/db_probe.rs).
//
// - A NEW connection each time (pg.Client on DATABASE_URL, exactly what a restart or a pool refill does) and SELECT 1,
//   within PROBE_TIMEOUT_MS. A pooled connection would have answered fine all through the incident.
// - Every PROBE_EVERY_MS in the background, only while the gateway's own Neon pool was used within ACTIVE_WINDOW_MS (or
//   the last probe failed, or none ran yet): a probe every 10 s with nothing using the database would keep Neon from
//   ever suspending.
// - GET /health: down = 503 {ok:false, status:"down", db:"down", reason}; otherwise 200 {ok:true, db} as before.
// - Logging: console.error on the first failure, again every LOG_REPEAT_MS while it lasts, one console.warn when back.

import pg from "pg";

export const PROBE_EVERY_MS = 10_000;
export const PROBE_TIMEOUT_MS = 2_000;
export const LOG_REPEAT_MS = 60_000;
export const STALE_AFTER_MS = 30_000;
export const ACTIVE_WINDOW_MS = 60_000;

export type Failure = "auth" | "unreachable" | "timeout" | "error";
export type Reading =
  | { kind: "starting" }
  | { kind: "ok" }
  | { kind: "idle" }
  | { kind: "down"; reason: Failure | "probe-stale"; secs: number };
export type Log = { kind: "raise"; reason: Failure } | { kind: "repeat"; reason: Failure; secs: number } | { kind: "recovered"; secs: number };

export function classify(e: unknown): Failure {
  const err = e as { code?: string; message?: string };
  if (err?.code === "28P01" || err?.code === "28000" || /password authentication failed/i.test(err?.message ?? "")) return "auth";
  if (err?.message === "probe timeout") return "timeout";
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(err?.code ?? "")) return "unreachable";
  return "error";
}

export class Probe {
  private checked: number | null = null;
  private idle = false;
  private down: { reason: Failure; since: number } | null = null;
  private lastLog: number | null = null;

  due(active: boolean): boolean {
    return active || this.down !== null || this.checked === null;
  }

  skipped(now: number): void {
    if (this.down) return;
    this.idle = true;
    this.checked = now;
  }

  record(result: Failure | null, now: number): Log | null {
    this.checked = now;
    this.idle = false;
    if (result === null) {
      if (!this.down) return null;
      const secs = Math.floor((now - this.down.since) / 1000);
      this.down = null;
      this.lastLog = now;
      return { kind: "recovered", secs };
    }
    if (!this.down) {
      this.down = { reason: result, since: now };
      this.lastLog = now;
      return { kind: "raise", reason: result };
    }
    this.down.reason = result;
    if (this.lastLog === null || now - this.lastLog >= LOG_REPEAT_MS) {
      this.lastLog = now;
      return { kind: "repeat", reason: result, secs: Math.floor((now - this.down.since) / 1000) };
    }
    return null;
  }

  reading(now: number): Reading {
    if (this.checked === null) return { kind: "starting" };
    if (this.down) return { kind: "down", reason: this.down.reason, secs: Math.floor((now - this.down.since) / 1000) };
    if (now - this.checked > STALE_AFTER_MS) return { kind: "down", reason: "probe-stale", secs: Math.floor((now - this.checked) / 1000) };
    return this.idle ? { kind: "idle" } : { kind: "ok" };
  }
}

/** /health's status and body for a reading (null = no probe running). */
export function healthBody(r: Reading | null): { status: number; body: Record<string, unknown> } {
  if (!r) return { status: 200, body: { ok: true } };
  if (r.kind === "down") return { status: 503, body: { ok: false, status: "down", db: "down", reason: r.reason, down_secs: r.secs } };
  return { status: 200, body: { ok: true, db: r.kind } };
}

/** One attempt: a NEW connection and SELECT 1, closed again; null = good. */
export async function attempt(connectionString: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Failure | null> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: timeoutMs });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.query("SELECT 1");
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("probe timeout")), timeoutMs); }),
    ]);
    return null;
  } catch (e) {
    const err = e as { message?: string };
    // pg's own connect timeout says "timeout expired"
    if (/timeout/i.test(err?.message ?? "") && !/authentication/i.test(err?.message ?? "")) return "timeout";
    return classify(e);
  } finally {
    clearTimeout(timer);
    client.end().catch(() => {});
  }
}

function log(entry: Log): void {
  if (entry.kind === "raise") console.error(`DB PROBE: the book database refuses NEW connections (${entry.reason}): /health answers 503; the pool's open connections keep working until they are replaced, a restart would not come back`);
  else if (entry.kind === "repeat") console.error(`DB PROBE: still down (${entry.reason}) for ${entry.secs} s`);
  else console.warn(`DB PROBE: the book database accepts new connections again after ${entry.secs} s`);
}

let running: Probe | null = null;
export function reading(): Reading | null {
  return running ? running.reading(Date.now()) : null;
}

/** Starts the probe loop; `active()` is asked before every probe. */
export function startProbe(connectionString: string, active: () => boolean): Probe {
  const probe = new Probe();
  running = probe;
  const tick = async () => {
    if (probe.due(active())) {
      const entry = probe.record(await attempt(connectionString), Date.now());
      if (entry) log(entry);
    } else probe.skipped(Date.now());
    setTimeout(tick, PROBE_EVERY_MS).unref();
  };
  void tick();
  return probe;
}
