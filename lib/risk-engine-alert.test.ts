import "dotenv/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stage 6 (c): the stale-heartbeat alert is ONE e-mail to the ops recipients when the engine's heartbeat has been stale on two checks while a
// broker is on the engine and trading is active, ONE recovery notice after a minute of fresh checks, debounced (no spam on flapping), silent over an
// idle market, and never a broker-visible notification. Real Redis; the e-mail sender is mocked.
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";

vi.mock("@/lib/email/adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/adapter")>()),
  sendPlatformEmail: vi.fn().mockResolvedValue({ usedMock: true }),
}));

import { sendPlatformEmail } from "@/lib/email/adapter";
import { checkEngineHeartbeatAlert, resetEngineAlertState, RECOVER_AFTER_SECS } from "@/lib/risk-engine-alert";
import { prisma } from "@/lib/prisma";
import type { EngineHeartbeat } from "@/lib/risk-fallback";

const send = vi.mocked(sendPlatformEmail);
const stale: EngineHeartbeat = { present: true, alive: false, ageSecs: 95, staleAfterSecs: 30, engineVersion: "0.1.0", instance: "VPS" };
const fresh: EngineHeartbeat = { present: true, alive: true, ageSecs: 2, staleAfterSecs: 30, engineVersion: "0.1.0", instance: "VPS" };
const at = (secs: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, 0) + secs * 1000);
const on = (heartbeat: EngineHeartbeat | null, extra: Partial<{ rust: boolean; active: boolean }> = {}) => ({ rust: true, active: true, heartbeat, ...extra });
let savedEmail: string | undefined;

beforeEach(async () => {
  savedEmail = process.env.OPS_ALERT_EMAIL;
  process.env.OPS_ALERT_EMAIL = "ops1@example.test, ops2@example.test";
  send.mockReset();
  send.mockResolvedValue({ usedMock: true });
  await resetEngineAlertState();
});
afterEach(async () => {
  if (savedEmail === undefined) delete process.env.OPS_ALERT_EMAIL;
  else process.env.OPS_ALERT_EMAIL = savedEmail;
  await resetEngineAlertState();
});

describe("stale-heartbeat alert (ops only)", () => {
  it("one stale check alerts nothing; the second consecutive one sends ONE e-mail to each ops recipient, then silence however long it stays stale", async () => {
    expect((await checkEngineHeartbeatAlert(on(stale), at(0))).action).toBeNull();
    expect(send).not.toHaveBeenCalled();
    const second = await checkEngineHeartbeatAlert(on(stale), at(60));
    expect(second).toEqual({ action: "ALERT", emailed: true });
    expect(send).toHaveBeenCalledTimes(2); // two recipients, one alert
    expect(send.mock.calls[0][0].subject).toContain("STALE");
    for (let i = 2; i < 30; i++) expect((await checkEngineHeartbeatAlert(on(stale), at(i * 60))).action).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("recovery: ONE notice only after a minute of continuous fresh checks", async () => {
    await checkEngineHeartbeatAlert(on(stale), at(0));
    await checkEngineHeartbeatAlert(on(stale), at(60));
    send.mockClear();
    expect((await checkEngineHeartbeatAlert(on(fresh), at(120))).action).toBeNull(); // first fresh check starts the clock
    expect(send).not.toHaveBeenCalled();
    const back = await checkEngineHeartbeatAlert(on(fresh), at(120 + RECOVER_AFTER_SECS));
    expect(back).toEqual({ action: "RECOVERED", emailed: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].subject).toContain("back");
    expect((await checkEngineHeartbeatAlert(on(fresh), at(400))).action).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("flapping does not spam: a stale check between fresh ones restarts the recovery clock, and a new outage inside the cooldown waits", async () => {
    await checkEngineHeartbeatAlert(on(stale), at(0));
    await checkEngineHeartbeatAlert(on(stale), at(60)); // alert 1
    await checkEngineHeartbeatAlert(on(fresh), at(120));
    await checkEngineHeartbeatAlert(on(stale), at(150)); // flaps stale: the fresh run restarts
    expect((await checkEngineHeartbeatAlert(on(fresh), at(180))).action).toBeNull();
    expect((await checkEngineHeartbeatAlert(on(fresh), at(180 + RECOVER_AFTER_SECS))).action).toBe("RECOVERED"); // recovery 1
    send.mockClear();
    // a new outage inside the cooldown: two stale checks, no new alert yet
    expect((await checkEngineHeartbeatAlert(on(stale), at(300))).action).toBeNull();
    expect((await checkEngineHeartbeatAlert(on(stale), at(360))).action).toBeNull();
    expect(send).not.toHaveBeenCalled();
    // after the cooldown, if it is STILL stale, it alerts once (a persistent outage is never lost)
    await new Promise((r) => setTimeout(r, 0));
    const { getRedis } = await import("@/lib/redis");
    await getRedis().del("risk-engine:alert:cooldown"); // the cooldown has run out
    expect((await checkEngineHeartbeatAlert(on(stale), at(1200))).action).toBe("ALERT");
  });

  it("a stale heartbeat with trading idle (a weekend: the idle gate stopped the beats) raises nothing and does not count", async () => {
    for (let i = 0; i < 10; i++) expect((await checkEngineHeartbeatAlert(on(stale, { active: false }), at(i * 60))).action).toBeNull();
    expect(send).not.toHaveBeenCalled();
    // and idle checks do not combine with one stale active check into an alert
    await checkEngineHeartbeatAlert(on(stale), at(700));
    await checkEngineHeartbeatAlert(on(stale, { active: false }), at(760));
    expect((await checkEngineHeartbeatAlert(on(stale), at(820))).action).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("an open alert is not closed or reopened by an idle gap", async () => {
    await checkEngineHeartbeatAlert(on(stale), at(0));
    await checkEngineHeartbeatAlert(on(stale), at(60)); // alert
    send.mockClear();
    for (let i = 0; i < 5; i++) await checkEngineHeartbeatAlert(on(fresh, { active: false }), at(120 + i * 60));
    expect(send).not.toHaveBeenCalled();
    await checkEngineHeartbeatAlert(on(stale), at(500));
    await checkEngineHeartbeatAlert(on(stale), at(560));
    expect(send).not.toHaveBeenCalled(); // still the same incident
  });

  it("no broker on the engine: nothing is sent, and an open state is cleared silently", async () => {
    expect((await checkEngineHeartbeatAlert(on(stale, { rust: false }), at(0))).action).toBeNull();
    expect((await checkEngineHeartbeatAlert(on(stale, { rust: false }), at(60))).action).toBeNull();
    expect(send).not.toHaveBeenCalled();
    await checkEngineHeartbeatAlert(on(stale), at(120));
    await checkEngineHeartbeatAlert(on(stale), at(180)); // alert
    send.mockClear();
    await checkEngineHeartbeatAlert(on(null, { rust: false }), at(240)); // flipped back to WEB
    await checkEngineHeartbeatAlert(on(stale), at(300));
    expect((await checkEngineHeartbeatAlert(on(stale), at(360))).action).toBe("ALERT"); // a fresh incident: a new alert, no stale "open" flag left
  });

  it("a missing heartbeat row counts as stale (nobody has beaten)", async () => {
    await checkEngineHeartbeatAlert(on({ present: false, alive: false, ageSecs: null, staleAfterSecs: null, engineVersion: null, instance: null }), at(0));
    expect((await checkEngineHeartbeatAlert(on(null), at(60))).action).toBe("ALERT");
    expect(send.mock.calls[0][0].text).toContain("Heartbeat:");
  });

  it("a failing e-mail leaves the incident un-opened so the next check retries; OPS_ALERT_EMAIL unset sends nothing and never throws", async () => {
    send.mockRejectedValueOnce(new Error("smtp down"));
    await checkEngineHeartbeatAlert(on(stale), at(0));
    expect((await checkEngineHeartbeatAlert(on(stale), at(60))).action).toBeNull();
    expect((await checkEngineHeartbeatAlert(on(stale), at(120))).action).toBe("ALERT"); // retried
    await resetEngineAlertState();
    delete process.env.OPS_ALERT_EMAIL;
    send.mockClear();
    await checkEngineHeartbeatAlert(on(stale), at(0));
    const r = await checkEngineHeartbeatAlert(on(stale), at(60));
    expect(r).toEqual({ action: "ALERT", emailed: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("brokers never see it: the alert path writes no Notification row and the text is e-mail only", async () => {
    const before = await prisma.notification.count();
    await checkEngineHeartbeatAlert(on(stale), at(0));
    await checkEngineHeartbeatAlert(on(stale), at(60));
    await checkEngineHeartbeatAlert(on(fresh), at(120));
    await checkEngineHeartbeatAlert(on(fresh), at(200));
    expect(await prisma.notification.count()).toBe(before);
    const src = (await import("node:fs")).readFileSync("lib/risk-engine-alert.ts", "utf8");
    expect(src).not.toMatch(/notification\./i);
    expect(src).not.toMatch(/createNotification|notifyAllBrokers/);
  });
});
