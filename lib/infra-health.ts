import "server-only";
import { getRedis } from "@/lib/redis";
import { sendPlatformEmail } from "@/lib/email/adapter";

// Infrastructure health reports pushed by VPS-side checks (owner 2026-10-05, after the Caddy nssm restart loop:
// deploy/caddy-service-recovery-runbook.md). A scheduled task on the VPS (deploy/vps/caddy-health-check.ps1) POSTs
// its result every 5 minutes to /api/internal/infra-health. This module stores the latest report per component in
// Redis, sends ONE alert e-mail when a component goes OK -> FAIL and ONE when it recovers (never repeats while the
// state is unchanged), and gives Feed health a summary that turns NO_REPORT when the check itself stops reporting.

export const INFRA_COMPONENTS = ["caddy"] as const;
export type InfraComponent = (typeof INFRA_COMPONENTS)[number];
export const RUNBOOKS: Record<InfraComponent, string> = { caddy: "deploy/caddy-service-recovery-runbook.md" };

/** No report for this long = the check is not running (the task runs every 5 minutes). */
export const NO_REPORT_AFTER_MS = 15 * 60 * 1000;
const REPORT_TTL_SECONDS = 24 * 60 * 60;

export type InfraReport = { ok: boolean; checks: Record<string, unknown>; reasons: string[]; checkedAt: string; host: string };
export type StoredInfraReport = InfraReport & { receivedAt: string; previousState: "OK" | "FAIL" | null };
export type InfraSummary = { state: "OK" | "FAIL" | "NO_REPORT"; checkedAt: string | null; reasons: string[] };

const reportKey = (c: InfraComponent) => `infra-health:${c}`;
const stateKey = (c: InfraComponent) => `infra-health:${c}:state`;

// Atomic swap: returns the previous state and stores the new one in one step, so two concurrent FAIL reports can
// never both see "OK" and both send an alert.
const SWAP = `local old = redis.call('GET', KEYS[1]); redis.call('SET', KEYS[1], ARGV[1]); return old`;
// Compare-and-restore: put the old state back only if nobody changed it since (used when an alert e-mail failed, so
// the next report retries the alert instead of losing it).
const RESTORE = `if redis.call('GET', KEYS[1]) == ARGV[1] then if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end return 1 end return 0`;

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

export function recipients(): string[] {
  return (process.env.OPS_ALERT_EMAIL ?? "").split(",").map((s) => s.trim()).filter((s) => s.includes("@"));
}

function alertText(component: InfraComponent, kind: "FAIL" | "RECOVERED", r: InfraReport) {
  const title = kind === "FAIL" ? `${component} check FAILED on ${r.host}` : `${component} check recovered on ${r.host}`;
  const lines = [
    title,
    "",
    `Component: ${component}`,
    `State: ${kind === "FAIL" ? "FAIL" : "OK (recovered)"}`,
    `Checked at (UTC): ${r.checkedAt}`,
    `Host: ${r.host}`,
    ...(r.reasons.length ? ["Reasons:", ...r.reasons.map((x) => `  - ${x}`)] : []),
    "",
    `Runbook: ${RUNBOOKS[component]}`,
  ];
  const text = lines.join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<pre style="font-family:Consolas,monospace;font-size:13px">${esc(text)}</pre>`;
  return { subject: `[VyX ops] ${title}`, text, html };
}

/** Stores the report and sends at most one alert per state change. Returns what happened. */
export async function recordInfraHealth(component: InfraComponent, report: InfraReport, now = new Date()) {
  const redis = getRedis();
  const state: "OK" | "FAIL" = report.ok ? "OK" : "FAIL";
  const previous = ((await redis.eval(SWAP, 1, stateKey(component), state)) as string | null) as "OK" | "FAIL" | null;
  const stored: StoredInfraReport = { ...report, receivedAt: now.toISOString(), previousState: previous };
  await redis.set(reportKey(component), JSON.stringify(stored), "EX", REPORT_TTL_SECONDS);

  // first report ever and OK: nothing to say. First report and FAIL: alert. Otherwise only on a change.
  const kind: "FAIL" | "RECOVERED" | null = state === "FAIL" ? (previous === "FAIL" ? null : "FAIL") : previous === "FAIL" ? "RECOVERED" : null;
  if (!kind) return { state, alerted: null as null | "FAIL" | "RECOVERED", emailed: false };

  const to = recipients();
  if (to.length === 0) {
    console.warn(`[infra-health] ${component} ${kind}: OPS_ALERT_EMAIL is not set, no alert e-mail sent`);
    return { state, alerted: kind, emailed: false };
  }
  const msg = alertText(component, kind, report);
  try {
    for (const addr of to) await sendPlatformEmail({ to: addr, ...msg });
    return { state, alerted: kind, emailed: true };
  } catch (err) {
    console.error(`[infra-health] ${component} ${kind}: alert e-mail failed, the next report retries`, err);
    await redis.eval(RESTORE, 1, stateKey(component), state, previous ?? "");
    return { state, alerted: kind, emailed: false };
  }
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
