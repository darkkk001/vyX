import "server-only";
import { getRedis } from "@/lib/redis";
import { sendPlatformEmail } from "@/lib/email/adapter";

// Infrastructure health reports pushed by VPS-side checks (owner 2026-10-05, after the Caddy nssm restart loop:
// deploy/caddy-service-recovery-runbook.md). A scheduled task on the VPS (deploy/vps/caddy-health-check.ps1) POSTs
// its result every 5 minutes to /api/internal/infra-health. This module stores the latest report per component in
// Redis, e-mails ops (OPS_ALERT_EMAIL) and gives Feed health a summary that turns NO_REPORT when the check itself stops
// reporting.
//
// Alert rule (owner 2026-10-28, after the zzzqa QoreBridge stayed stopped for 17 h with no e-mail: the component was
// already FAIL for another reason, and FAIL -> FAIL never alerted). docs/INFRA-ALERTS-DESIGN.md.
//   * FAIL: an e-mail when the component starts failing AND whenever a NEW failure key appears while it is failing
//     (a report's checks.failing: stable keys like "license_state"; the reasons text when a check sends none), plus
//     one reminder every REMIND_EVERY_MS while it stays failing. A key that clears and comes back alerts again.
//   * OK after an e-mailed FAIL: one recovery e-mail.
//   * NO REPORT for NO_REPORT_AFTER_MS from a component that has reported before (task stopped, VPS down, the report
//     refused with 401 after a secret rotation or 403 by a firewall): one STALE e-mail, and one when reports resume.
//     checkInfraStale() runs once a minute from the risk-fallback cron.
//   * The daily break (16:59-18:00 New York time = 20:59-22:00 UTC in summer, 21:59-23:00 UTC in winter; deploys and
//     restarts happen there): no FAIL / STALE e-mail. A failure still there after the break alerts at the first report
//     after it; a check silent through the break gets NO_REPORT_AFTER_MS from the break's end before it is STALE.

// qorebridge: the VPS bridge health task (owner 2026-10-26); database: the engine's and the gateway's book-database probe
// read by deploy/vps/db-health-check.ps1 (incident 2026-10-27: the DB refused new connections for 28 min, all green)
export const INFRA_COMPONENTS = ["caddy", "qorebridge", "database"] as const;
export type InfraComponent = (typeof INFRA_COMPONENTS)[number];
export const RUNBOOKS: Record<InfraComponent, string> = {
  caddy: "deploy/caddy-service-recovery-runbook.md",
  qorebridge: "deploy/qorebridge-vps-runbook.md",
  database: "deploy/db-health-runbook.md",
};

/** No report for this long = the check is not running (the task runs every 5 minutes). */
export const NO_REPORT_AFTER_MS = 15 * 60 * 1000;
/** While a component stays failing, one reminder this often. */
export const REMIND_EVERY_MS = 6 * 60 * 60 * 1000;
const REPORT_TTL_SECONDS = 24 * 60 * 60;

export type InfraReport = { ok: boolean; checks: Record<string, unknown>; reasons: string[]; checkedAt: string; host: string };
export type StoredInfraReport = InfraReport & { receivedAt: string; previousState: "OK" | "FAIL" | null };
export type InfraSummary = { state: "OK" | "FAIL" | "NO_REPORT"; checkedAt: string | null; reasons: string[] };
export type InfraAlert = "FAIL" | "REMINDER" | "RECOVERED";
export type StaleAlert = "STALE" | "REPORTING";

const reportKey = (c: InfraComponent) => `infra-health:${c}`;
const stateKey = (c: InfraComponent) => `infra-health:${c}:state`;
const alertedKey = (c: InfraComponent) => `infra-health:${c}:alerted`; // JSON array: the failure keys ops was told about
const remindKey = (c: InfraComponent) => `infra-health:${c}:remind-at`; // ms of the next reminder
const staleKey = (c: InfraComponent) => `infra-health:${c}:stale`; // "1" while a STALE e-mail stands
const lockKey = (c: InfraComponent) => `infra-health:${c}:lock`; // one decision at a time per component

// Atomic swap: returns the previous state and stores the new one in one step (previousState of the stored report).
const SWAP = `local old = redis.call('GET', KEYS[1]); redis.call('SET', KEYS[1], ARGV[1]); return old`;

/** Parses and bounds a report body. Returns null when anything is malformed. */
export function parseInfraReport(body: unknown): { component: InfraComponent; report: InfraReport } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.component !== "string" || !(INFRA_COMPONENTS as readonly string[]).includes(b.component)) return null;
  if (typeof b.ok !== "boolean") return null;
  if (typeof b.checkedAt !== "string" || Number.isNaN(Date.parse(b.checkedAt))) return null;
  if (typeof b.host !== "string" || b.host.length === 0 || b.host.length > 100) return null;
  const reasons = Array.isArray(b.reasons) ? b.reasons : [];
  if (reasons.length > 20 || reasons.some((r) => typeof r !== "string" || r.length > 300)) return null;
  const checks = b.checks && typeof b.checks === "object" && !Array.isArray(b.checks) ? (b.checks as Record<string, unknown>) : {};
  if (JSON.stringify(checks).length > 4000) return null;
  return { component: b.component as InfraComponent, report: { ok: b.ok, checks, reasons: reasons as string[], checkedAt: new Date(b.checkedAt).toISOString(), host: b.host } };
}

/** The failure keys of a report: checks.failing when the check sends stable keys, else its reasons text. */
export function failureKeys(r: InfraReport): string[] {
  const f = r.checks.failing;
  const keys = Array.isArray(f) && f.length > 0 && f.every((k) => typeof k === "string" && k.length > 0 && k.length <= 60) ? (f as string[]) : r.reasons;
  return [...new Set(keys.length ? keys : ["failing"])].sort();
}

/** New York wall-clock minutes of the day (DST-aware). */
function newYorkMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}
const BREAK_START = 16 * 60 + 59; // 16:59 New York
const BREAK_END = 18 * 60; // 18:00 New York

/** The platform's daily break: 16:59-18:00 New York time. */
export function inDailyBreak(now: Date): boolean {
  const m = newYorkMinutes(now);
  return m >= BREAK_START && m < BREAK_END;
}

/** Milliseconds since the last daily break ended (18:00 New York). */
export function msSinceBreakEnd(now: Date): number {
  const m = newYorkMinutes(now);
  return ((m - BREAK_END + 1440) % 1440) * 60_000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
}

export function recipients(): string[] {
  return (process.env.OPS_ALERT_EMAIL ?? "").split(",").map((s) => s.trim()).filter((s) => s.includes("@"));
}

function render(title: string, lines: string[]) {
  const text = [title, "", ...lines].join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<pre style="font-family:Consolas,monospace;font-size:13px">${esc(text)}</pre>`;
  return { subject: `[VyX ops] ${title}`, text, html };
}

function alertText(component: InfraComponent, kind: InfraAlert, r: InfraReport, newKeys: string[]) {
  const title =
    kind === "FAIL" ? `${component} check FAILED on ${r.host}` : kind === "REMINDER" ? `${component} check STILL FAILING on ${r.host}` : `${component} check recovered on ${r.host}`;
  return render(title, [
    `Component: ${component}`,
    `State: ${kind === "RECOVERED" ? "OK (recovered)" : kind === "REMINDER" ? "FAIL (reminder: still failing)" : "FAIL"}`,
    `Checked at (UTC): ${r.checkedAt}`,
    `Host: ${r.host}`,
    ...(newKeys.length && kind === "FAIL" ? [`New failure: ${newKeys.join(", ")}`] : []),
    ...(r.reasons.length ? ["Reasons:", ...r.reasons.map((x) => `  - ${x}`)] : []),
    "",
    `Runbook: ${RUNBOOKS[component]}`,
  ]);
}

async function mail(tag: string, msg: { subject: string; text: string; html: string }): Promise<boolean> {
  const to = recipients();
  if (to.length === 0) {
    console.warn(`[infra-health] ${tag}: OPS_ALERT_EMAIL is not set, no alert e-mail sent`);
    return false;
  }
  try {
    for (const addr of to) await sendPlatformEmail({ to: addr, ...msg });
    return true;
  } catch (err) {
    console.error(`[infra-health] ${tag}: alert e-mail failed, the next check retries`, err);
    return false;
  }
}

async function readAlerted(component: InfraComponent): Promise<string[]> {
  try {
    const v = JSON.parse((await getRedis().get(alertedKey(component))) ?? "[]");
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** Stores the report and decides the e-mail (module comment). Returns what happened. */
export async function recordInfraHealth(component: InfraComponent, report: InfraReport, now = new Date()) {
  const redis = getRedis();
  const state: "OK" | "FAIL" = report.ok ? "OK" : "FAIL";
  const previous = ((await redis.eval(SWAP, 1, stateKey(component), state)) as string | null) as "OK" | "FAIL" | null;
  const stored: StoredInfraReport = { ...report, receivedAt: now.toISOString(), previousState: previous };
  await redis.set(reportKey(component), JSON.stringify(stored), "EX", REPORT_TTL_SECONDS);
  const none = { state, alerted: null as InfraAlert | null, emailed: false, deferred: false };

  // concurrent reports: only one decides (the others are the same news); released at the end, expires if a run dies
  if ((await redis.set(lockKey(component), "1", "PX", 15_000, "NX")) !== "OK") return none;
  try {
    return await decide(component, report, state, now, none);
  } finally {
    await redis.del(lockKey(component));
  }
}

async function decide(component: InfraComponent, report: InfraReport, state: "OK" | "FAIL", now: Date, none: { state: "OK" | "FAIL"; alerted: InfraAlert | null; emailed: boolean; deferred: boolean }) {
  const redis = getRedis();
  const alerted = await readAlerted(component);
  if (state === "OK") {
    // nobody was told it failed (or a FAIL deferred by the break recovered inside it): nothing to say
    if (alerted.length === 0) return none;
    const emailed = await mail(`${component} RECOVERED`, alertText(component, "RECOVERED", report, []));
    if (emailed) await redis.del(alertedKey(component), remindKey(component));
    return { ...none, alerted: "RECOVERED" as const, emailed };
  }

  const keys = failureKeys(report);
  if (inDailyBreak(now)) return { ...none, deferred: true };
  const newKeys = keys.filter((k) => !alerted.includes(k));
  const remindAt = Number((await redis.get(remindKey(component))) ?? "0");
  const kind: InfraAlert | null = alerted.length === 0 || newKeys.length > 0 ? "FAIL" : now.getTime() >= remindAt ? "REMINDER" : null;
  if (!kind) {
    // a key that cleared is forgotten, so it alerts again when it comes back
    const still = alerted.filter((k) => keys.includes(k));
    if (still.length !== alerted.length) await redis.set(alertedKey(component), JSON.stringify(still));
    return none;
  }
  const emailed = await mail(`${component} ${kind}`, alertText(component, kind, report, alerted.length === 0 ? [] : newKeys));
  // a failed e-mail changes nothing, so the next report retries it
  if (emailed) {
    await redis.set(alertedKey(component), JSON.stringify(keys));
    await redis.set(remindKey(component), String(now.getTime() + REMIND_EVERY_MS));
  }
  return { ...none, alerted: kind, emailed };
}

/** Once a minute (risk-fallback cron): a component that reported before and went silent -> one STALE e-mail, one when it
 *  reports again. Never during the daily break; a check silent through the break gets NO_REPORT_AFTER_MS after it. */
export async function checkInfraStale(now = new Date()): Promise<Partial<Record<InfraComponent, StaleAlert>>> {
  const redis = getRedis();
  const out: Partial<Record<InfraComponent, StaleAlert>> = {};
  if (inDailyBreak(now)) return out;
  for (const component of INFRA_COMPONENTS) {
    // no state at all: this check was never installed, nothing to miss
    if ((await redis.get(stateKey(component))) === null) continue;
    const raw = await redis.get(reportKey(component));
    let receivedAt = 0;
    let host = "unknown host";
    try {
      if (raw) {
        const r = JSON.parse(raw) as StoredInfraReport;
        receivedAt = Date.parse(r.receivedAt) || 0;
        host = r.host || host;
      }
    } catch {
      receivedAt = 0;
    }
    const age = now.getTime() - receivedAt;
    const stale = age > NO_REPORT_AFTER_MS && msSinceBreakEnd(now) > NO_REPORT_AFTER_MS;
    const open = (await redis.get(staleKey(component))) === "1";
    if (stale === open) continue;
    const last = receivedAt ? new Date(receivedAt).toISOString() : "none in the last 24 h";
    const msg = stale
      ? render(`${component} check is NOT REPORTING (${host})`, [
          `Component: ${component}`,
          `Last report received (UTC): ${last}`,
          `Now (UTC): ${now.toISOString()}`,
          "",
          "No report for more than 15 minutes. The check's own state is unknown: the scheduled task stopped, the VPS is down,",
          "or its report is refused (401 after a secret rotation, 403 from a firewall). The task's status file on the VPS says which.",
          "",
          `Runbook: ${RUNBOOKS[component]}`,
        ])
      : render(`${component} check is reporting again (${host})`, [`Component: ${component}`, `Last report received (UTC): ${last}`, `Now (UTC): ${now.toISOString()}`]);
    const kind: StaleAlert = stale ? "STALE" : "REPORTING";
    if (await mail(`${component} ${kind}`, msg)) {
      if (stale) await redis.set(staleKey(component), "1");
      else await redis.del(staleKey(component));
      out[component] = kind;
    }
  }
  return out;
}

/** Feed health's view: OK / FAIL from the latest report, NO_REPORT when none arrived for 15 minutes. */
export async function readInfraSummary(component: InfraComponent, now = Date.now()): Promise<InfraSummary> {
  try {
    const raw = await getRedis().get(reportKey(component));
    if (!raw) return { state: "NO_REPORT", checkedAt: null, reasons: ["no report received: the check is not running"] };
    const r = JSON.parse(raw) as StoredInfraReport;
    if (now - Date.parse(r.receivedAt) > NO_REPORT_AFTER_MS) {
      return { state: "NO_REPORT", checkedAt: r.checkedAt, reasons: ["no report for 15 minutes: the check is not running"] };
    }
    return { state: r.ok ? "OK" : "FAIL", checkedAt: r.checkedAt, reasons: r.reasons };
  } catch {
    return { state: "NO_REPORT", checkedAt: null, reasons: ["status store unavailable"] };
  }
}
