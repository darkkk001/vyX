import "server-only";
import { getRedis } from "@/lib/redis";
import { sendPlatformEmail } from "@/lib/email/adapter";
import { recipients } from "@/lib/infra-health";
import type { EngineHeartbeat } from "@/lib/risk-fallback";

// Stage 6 (owner decision c, 2026-10-07): the stale-heartbeat alert. SUPER-ADMIN / OPS ONLY: it goes to OPS_ALERT_EMAIL, the
// same ops mechanism as the Caddy check (lib/infra-health.ts), and never into a broker's notifications (brokers never see
// infrastructure). No Notification row is written, so no broker-facing surface can show it.
//
// The rule. Evaluated once a minute by the fallback route (app/api/internal/risk-fallback), and only when
//   * at least one broker is RUST, AND
//   * trading is active (the engine's book gate is open, or unreadable): a heartbeat that went stale because the idle gate
//     stopped the beats over a weekend is NOT an outage and raises nothing.
// Then:
//   * stale (older than the heartbeat's own staleAfterSecs, N = 30 s by default) on STALE_CHECKS_TO_ALERT consecutive checks
//     (two: about a minute apart, so the first moments after a reopen, when the first beat is milliseconds away, never alert)
//     and not within COOLDOWN_SECS of the last recovery  ->  ONE alert, and the state "open" is stored;
//   * while open, nothing more is sent however long it stays stale;
//   * fresh on RECOVER_AFTER_SECS of continuous fresh checks (a flapping engine does not send a notice per flap)
//     ->  ONE recovery notice, the state is cleared, a cooldown starts (a stale beat within it waits, and alerts when it persists).
//   * no broker on the engine any more, or an idle market: the state is kept (an idle gap never closes or opens an incident);
//     with no broker on the engine the open state is cleared silently (nothing left to alert about).
// State lives in Redis (shared by every serverless instance), the transitions are single atomic commands.

export const STALE_CHECKS_TO_ALERT = 2;
export const RECOVER_AFTER_SECS = 60;
export const COOLDOWN_SECS = 600;
const K = {
  open: "risk-engine:alert:open", // "1" while an alert has been sent and no recovery yet
  stale: "risk-engine:alert:stale-checks", // consecutive stale checks (expires: a gap in checks is not "consecutive")
  freshSince: "risk-engine:alert:fresh-since", // ms of the first fresh check of the current fresh run, while open
  cooldown: "risk-engine:alert:cooldown",
};

export type AlertInput = {
  /** at least one broker has riskAuthority = RUST */
  rust: boolean;
  /** trading is active (the engine's book gate is open, or could not be read) */
  active: boolean;
  heartbeat: EngineHeartbeat | null;
};
export type AlertAction = "ALERT" | "RECOVERED" | null;

function message(kind: "ALERT" | "RECOVERED", hb: EngineHeartbeat | null, now: Date) {
  const age = hb?.ageSecs == null ? "no heartbeat row" : `${Math.round(hb.ageSecs)} s old (stale after ${hb.staleAfterSecs} s)`;
  const title = kind === "ALERT" ? "Risk engine heartbeat is STALE: the web has taken over" : "Risk engine heartbeat is back";
  const lines =
    kind === "ALERT"
      ? [
          title,
          "",
          `Time (UTC): ${now.toISOString()}`,
          `Heartbeat: ${age}`,
          hb?.engineVersion ? `Last engine version: ${hb.engineVersion}${hb.instance ? ` on ${hb.instance}` : ""}` : "",
          "",
          "Trading is active and at least one broker is on the engine, but the engine has not beaten for longer than its window on two checks.",
          "Every account on the engine is now evaluated by the web (stop-outs, SL / TP, margin calls), through the 1-minute fallback. Nothing is double-acted:",
          "each side re-checks the heartbeat inside every acting transaction.",
          "",
          "Check the engine service on the VPS (docs/STAGE6-RUNBOOK-FUTURIX-DEMO.md section 7, drill B). A recovery notice follows when it beats again.",
        ]
      : [
          title,
          "",
          `Time (UTC): ${now.toISOString()}`,
          `Heartbeat: ${age}`,
          "",
          "The engine owns its accounts again; the web has stepped back.",
        ];
  const text = lines.filter((l, i) => l !== "" || i === 0 || lines[i - 1] !== "").join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { subject: `[VyX ops] ${title}`, text, html: `<pre style="font-family:Consolas,monospace;font-size:13px">${esc(text)}</pre>` };
}

async function send(kind: "ALERT" | "RECOVERED", hb: EngineHeartbeat | null, now: Date): Promise<boolean> {
  const to = recipients();
  if (to.length === 0) {
    console.warn(`[risk-engine-alert] ${kind}: OPS_ALERT_EMAIL is not set, no e-mail sent`);
    return false;
  }
  const msg = message(kind, hb, now);
  for (const addr of to) await sendPlatformEmail({ to: addr, ...msg });
  return true;
}

/**
 * One check. Returns what it sent. Never throws: a failing alert path must not break the fallback pass that called it
 * (a failed e-mail leaves the state as before, so the next check retries).
 */
export async function checkEngineHeartbeatAlert(input: AlertInput, now = new Date()): Promise<{ action: AlertAction; emailed: boolean }> {
  try {
    const redis = getRedis();
    if (!input.rust) {
      await redis.del(K.open, K.stale, K.freshSince);
      return { action: null, emailed: false };
    }
    if (!input.active) {
      // an idle gap: no beats on purpose. Nothing counts, nothing opens or closes.
      await redis.del(K.stale, K.freshSince);
      return { action: null, emailed: false };
    }
    const alive = input.heartbeat?.alive === true;
    if (!alive) {
      await redis.del(K.freshSince);
      const checks = await redis.incr(K.stale);
      await redis.expire(K.stale, 300);
      if (checks < STALE_CHECKS_TO_ALERT) return { action: null, emailed: false };
      if (await redis.exists(K.cooldown)) return { action: null, emailed: false };
      // atomic open: only the instance that flips it sends
      if ((await redis.set(K.open, "1", "NX")) !== "OK") return { action: null, emailed: false };
      try {
        const emailed = await send("ALERT", input.heartbeat, now);
        return { action: "ALERT", emailed };
      } catch (err) {
        console.error("[risk-engine-alert] alert e-mail failed, the next check retries", err);
        await redis.del(K.open);
        return { action: null, emailed: false };
      }
    }
    // fresh
    await redis.del(K.stale);
    if (!(await redis.exists(K.open))) return { action: null, emailed: false };
    await redis.set(K.freshSince, String(now.getTime()), "NX");
    const since = Number(await redis.get(K.freshSince));
    if (!Number.isFinite(since) || now.getTime() - since < RECOVER_AFTER_SECS * 1000) return { action: null, emailed: false };
    // atomic close: only the instance that deletes the open flag sends
    if ((await redis.del(K.open)) !== 1) return { action: null, emailed: false };
    await redis.del(K.freshSince);
    await redis.set(K.cooldown, "1", "EX", COOLDOWN_SECS);
    try {
      const emailed = await send("RECOVERED", input.heartbeat, now);
      return { action: "RECOVERED", emailed };
    } catch (err) {
      console.error("[risk-engine-alert] recovery e-mail failed, the next check retries", err);
      await redis.set(K.open, "1");
      await redis.del(K.cooldown);
      return { action: null, emailed: false };
    }
  } catch (err) {
    console.error("[risk-engine-alert] check failed", err);
    return { action: null, emailed: false };
  }
}

/** Test hook. */
export async function resetEngineAlertState(): Promise<void> {
  await getRedis().del(K.open, K.stale, K.freshSince, K.cooldown);
}
