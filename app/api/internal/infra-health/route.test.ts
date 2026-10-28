import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Infra health (owner 2026-10-05, after the Caddy nssm restart loop): the VPS check POSTs here; one alert e-mail on
// OK -> FAIL and one on recovery, never repeated while the state is unchanged; Feed health shows OK / FAIL /
// NO_REPORT. Real Redis (scratch / Memurai); the e-mail sender and the admin session are mocked.
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";

vi.mock("@/lib/email/adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/adapter")>()),
  sendPlatformEmail: vi.fn().mockResolvedValue({ usedMock: true }),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/synthetic-symbols", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/synthetic-symbols")>()),
  brokerMaySeeSynthetic: vi.fn().mockResolvedValue(false),
}));

import { sendPlatformEmail } from "@/lib/email/adapter";
import { getAdminSession } from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import { POST } from "@/app/api/internal/infra-health/route";
import { INFRA_COMPONENTS, checkInfraStale, inDailyBreak, readInfraSummary, recordInfraHealth, REMIND_EVERY_MS } from "@/lib/infra-health";

const SECRET = "infra-test-secret";
const saved: Record<string, string | undefined> = {};
const KEYS = ["INTERNAL_SERVICE_SECRET", "OPS_ALERT_EMAIL", "TRADING_CORE_URL", "GATEWAY_URL"];
const send = vi.mocked(sendPlatformEmail);

async function clearKeys() {
  const parts = ["", ":state", ":alerted", ":remind-at", ":stale", ":lock"];
  await getRedis().del(...INFRA_COMPONENTS.flatMap((c) => parts.map((p) => `infra-health:${c}${p}`)));
}
beforeEach(async () => {
  // a fixed weekday clock outside the daily break (16:59-18:00 New York), so the break gate never makes a run flaky
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.INTERNAL_SERVICE_SECRET = SECRET;
  process.env.OPS_ALERT_EMAIL = "ops1@example.test, ops2@example.test";
  send.mockReset();
  send.mockResolvedValue({ usedMock: true });
  await clearKeys();
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => {
  await clearKeys();
});

function report(ok: boolean, reasons: string[] = [], checkedAt = new Date().toISOString()) {
  return { component: "caddy", ok, reasons, checkedAt, host: "vps-test", checks: { processCount: ok ? 1 : 2 } };
}
function post(body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-internal-secret"] = secret;
  return POST(new NextRequest("https://test.local/api/internal/infra-health", { method: "POST", headers, body: JSON.stringify(body) }));
}

describe("auth", () => {
  it("no header -> 401, nothing stored", async () => {
    const res = await post(report(false), null);
    expect(res.status).toBe(401);
    expect(await getRedis().get("infra-health:caddy")).toBeNull();
  });
  it("wrong secret -> 401", async () => {
    expect((await post(report(false), "nope")).status).toBe(401);
  });
  it("secret unset on the server -> 401 even for an empty header", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    expect((await post(report(true), "")).status).toBe(401);
  });
});

describe("validation", () => {
  it("unknown component, missing ok, bad date, too many reasons -> 400", async () => {
    expect((await post({ ...report(true), component: "nginx" })).status).toBe(400);
    expect((await post({ ...report(true), ok: "yes" })).status).toBe(400);
    expect((await post({ ...report(true), checkedAt: "yesterday" })).status).toBe(400);
    expect((await post({ ...report(false), reasons: Array.from({ length: 21 }, () => "x") })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("qorebridge (owner 2026-10-26: the VPS bridge health task got 400)", () => {
  it("a qorebridge report is stored and read on its own, separate from caddy; an unknown component is still 400", async () => {
    const res = await post({ ...report(true), component: "qorebridge", checks: { service: "Running", health: "ok" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: true, state: "OK", alerted: null });
    expect(await getRedis().get("infra-health:qorebridge")).not.toBeNull();
    expect(await getRedis().get("infra-health:caddy")).toBeNull();
    expect((await readInfraSummary("qorebridge")).state).toBe("OK");
    expect((await readInfraSummary("caddy")).state).toBe("NO_REPORT");
    expect((await post({ ...report(true), component: "qorebridge-x" })).status).toBe(400);
  });
  it("its failure alert names the bridge runbook", async () => {
    await post({ ...report(true), component: "qorebridge" });
    const r = await (await post({ ...report(false, ["service Stopped"]), component: "qorebridge" })).json();
    expect(r).toMatchObject({ state: "FAIL", alerted: "FAIL" });
    expect(send.mock.calls[0][0].text).toContain("deploy/qorebridge-vps-runbook.md");
  });
});

describe("alerts: one per state change (and per new failure, below)", () => {
  it("first report OK: stored, no e-mail", async () => {
    const res = await post(report(true));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: true, state: "OK", alerted: null });
    expect(send).not.toHaveBeenCalled();
  });
  it("OK -> FAIL sends one alert (to each recipient), repeated FAIL sends none, FAIL -> OK sends one recovered", async () => {
    await post(report(true));
    const r1 = await (await post(report(false, ["2 caddy.exe processes", "service SERVICE_PAUSED"]))).json();
    expect(r1).toMatchObject({ state: "FAIL", alerted: "FAIL", emailed: true });
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0][0];
    expect(first.to).toBe("ops1@example.test");
    expect(first.subject).toBe("[VyX ops] caddy check FAILED on vps-test");
    expect(first.text).toContain("2 caddy.exe processes");
    expect(first.text).toContain("deploy/caddy-service-recovery-runbook.md");

    send.mockClear();
    for (let i = 0; i < 3; i++) expect(await (await post(report(false, ["2 caddy.exe processes", "service SERVICE_PAUSED"]))).json()).toMatchObject({ state: "FAIL", alerted: null });
    expect(send).not.toHaveBeenCalled();

    const r2 = await (await post(report(true))).json();
    expect(r2).toMatchObject({ state: "OK", alerted: "RECOVERED", emailed: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].subject).toBe("[VyX ops] caddy check recovered on vps-test");

    send.mockClear();
    await post(report(true));
    expect(send).not.toHaveBeenCalled();
  });
  it("very first report is FAIL: alerts", async () => {
    expect(await (await post(report(false, ["feed /health 502"]))).json()).toMatchObject({ alerted: "FAIL" });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("8 concurrent FAIL reports after OK send exactly one alert", async () => {
    process.env.OPS_ALERT_EMAIL = "ops1@example.test";
    await post(report(true));
    const results = await Promise.all(Array.from({ length: 8 }, () => post(report(false, ["bind errors"])).then((r) => r.json())));
    expect(results.filter((r) => r.alerted === "FAIL")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("no OPS_ALERT_EMAIL: state still stored and the change reported, no e-mail", async () => {
    delete process.env.OPS_ALERT_EMAIL;
    await post(report(true));
    expect(await (await post(report(false))).json()).toMatchObject({ state: "FAIL", alerted: "FAIL", emailed: false });
    expect(send).not.toHaveBeenCalled();
    expect((await readInfraSummary("caddy")).state).toBe("FAIL");
  });
  it("a failed alert e-mail is retried on the next report (state put back), then not repeated", async () => {
    process.env.OPS_ALERT_EMAIL = "ops1@example.test";
    await post(report(true));
    send.mockRejectedValueOnce(new Error("Resend send failed (500)"));
    expect(await (await post(report(false))).json()).toMatchObject({ alerted: "FAIL", emailed: false });
    expect(await (await post(report(false))).json()).toMatchObject({ alerted: "FAIL", emailed: true });
    expect(await (await post(report(false))).json()).toMatchObject({ alerted: null });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("feed health (broker-facing): never shows our infrastructure", () => {
  async function feedHealthBody(role: "BROKER_ADMIN" | "MANAGER") {
    vi.mocked(getAdminSession).mockResolvedValue({ role, brokerId: "b_test", adminId: "a_test" } as never);
    process.env.TRADING_CORE_URL = "http://127.0.0.1:1";
    process.env.GATEWAY_URL = "http://127.0.0.1:1";
    const { GET } = await import("@/app/api/manage/feed-health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }
  for (const role of ["BROKER_ADMIN", "MANAGER"] as const) {
    it(`${role}: no infra field, whatever the Caddy state is`, async () => {
      expect(await feedHealthBody(role)).not.toHaveProperty("infra");
      await post(report(true));
      expect(await feedHealthBody(role)).not.toHaveProperty("infra");
      await post(report(false, ["service SERVICE_PAUSED"]));
      const body = await feedHealthBody(role);
      expect(body).not.toHaveProperty("infra");
      expect(JSON.stringify(body)).not.toMatch(/caddy|SERVICE_PAUSED/i);
    });
  }
  it("SUPPORT and non-staff are refused (403)", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ role: "SUPPORT", brokerId: "b_test", adminId: "a_test" } as never);
    const { GET } = await import("@/app/api/manage/feed-health/route");
    expect((await GET()).status).toBe(403);
    vi.mocked(getAdminSession).mockResolvedValue(null as never);
    expect((await GET()).status).toBe(403);
  });
});

describe("infra state (ops only, unchanged)", () => {
  it("NO_REPORT when nothing was ever reported", async () => {
    expect(await readInfraSummary("caddy")).toMatchObject({ state: "NO_REPORT", checkedAt: null });
  });
  it("OK, then FAIL with the reasons", async () => {
    await post(report(true));
    expect(await readInfraSummary("caddy")).toMatchObject({ state: "OK" });
    await post(report(false, ["service SERVICE_PAUSED"]));
    expect(await readInfraSummary("caddy")).toMatchObject({ state: "FAIL", reasons: ["service SERVICE_PAUSED"] });
  });
  it("NO_REPORT when the last report is older than 15 minutes", async () => {
    await post(report(true));
    expect((await readInfraSummary("caddy", Date.now() + 16 * 60 * 1000)).state).toBe("NO_REPORT");
    expect((await readInfraSummary("caddy", Date.now() + 14 * 60 * 1000)).state).toBe("OK");
  });
});

// Owner 2026-10-28: the zzzqa QoreBridge stayed stopped for 17 h and nobody heard. The component was already FAIL for
// another reason, so FAIL -> FAIL said nothing; and a check that stops reporting was only visible on Feed health.
describe("alert gaps (owner 2026-10-28)", () => {
  const NOON = new Date("2026-10-28T12:00:00Z"); // 08:00 New York, far from the break
  const at = (base: Date, mins: number) => new Date(base.getTime() + mins * 60_000);
  function bridge(ok: boolean, failing: string[] = [], reasons: string[] = failing.map((k) => `${k} text ${Math.random()}`)) {
    return { ok, checks: { failing }, reasons, checkedAt: NOON.toISOString(), host: "vps-test" };
  }
  beforeEach(() => {
    process.env.OPS_ALERT_EMAIL = "ops1@example.test";
  });

  it("a NEW failure key while already failing alerts again and names it; the same keys with new text do not", async () => {
    expect(await recordInfraHealth("qorebridge", bridge(false, ["lp_sessions"]), NOON)).toMatchObject({ alerted: "FAIL", emailed: true });
    // same key, different reason text (counts in it change): no e-mail
    expect(await recordInfraHealth("qorebridge", bridge(false, ["lp_sessions"]), at(NOON, 5))).toMatchObject({ alerted: null });
    // the 10-27 case: the license stops while LP sessions were already down
    expect(await recordInfraHealth("qorebridge", bridge(false, ["license_state", "lp_sessions"]), at(NOON, 10))).toMatchObject({ alerted: "FAIL", emailed: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].text).toContain("New failure: license_state");
    expect(await recordInfraHealth("qorebridge", bridge(false, ["license_state", "lp_sessions"]), at(NOON, 15))).toMatchObject({ alerted: null });
  });
  it("a key that clears and comes back alerts again; recovery after an alert sends one e-mail", async () => {
    await recordInfraHealth("qorebridge", bridge(false, ["lp_sessions", "license_state"]), NOON);
    await recordInfraHealth("qorebridge", bridge(false, ["lp_sessions"]), at(NOON, 5));
    expect(await recordInfraHealth("qorebridge", bridge(false, ["lp_sessions", "license_state"]), at(NOON, 10))).toMatchObject({ alerted: "FAIL" });
    expect(await recordInfraHealth("qorebridge", bridge(true), at(NOON, 15))).toMatchObject({ alerted: "RECOVERED", emailed: true });
    expect(await recordInfraHealth("qorebridge", bridge(true), at(NOON, 20))).toMatchObject({ alerted: null });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("one reminder every 6 h while it stays failing", async () => {
    await recordInfraHealth("qorebridge", bridge(false, ["license_state"]), NOON);
    const sixH = REMIND_EVERY_MS / 60_000;
    expect(await recordInfraHealth("qorebridge", bridge(false, ["license_state"]), at(NOON, sixH - 1))).toMatchObject({ alerted: null });
    expect(await recordInfraHealth("qorebridge", bridge(false, ["license_state"]), at(NOON, sixH))).toMatchObject({ alerted: "REMINDER", emailed: true });
    expect(send.mock.calls[1][0].subject).toBe("[VyX ops] qorebridge check STILL FAILING on vps-test");
    expect(await recordInfraHealth("qorebridge", bridge(false, ["license_state"]), at(NOON, sixH + 5))).toMatchObject({ alerted: null });
  });
  it("the daily break defers a FAIL to the first report after it; one that recovers inside the break never mails", async () => {
    const inBreak = new Date("2026-10-28T21:30:00Z"); // 17:30 New York (EDT)
    const after = new Date("2026-10-28T22:05:00Z"); // 18:05 New York
    expect([inDailyBreak(inBreak), inDailyBreak(after), inDailyBreak(new Date("2026-11-02T21:30:00Z")), inDailyBreak(new Date("2026-11-02T22:30:00Z"))]).toEqual([true, false, false, true]);
    expect(await recordInfraHealth("qorebridge", bridge(false, ["health_down"]), inBreak)).toMatchObject({ state: "FAIL", deferred: true, alerted: null });
    expect(await recordInfraHealth("qorebridge", bridge(false, ["health_down"]), after)).toMatchObject({ alerted: "FAIL", emailed: true });
    await clearKeys();
    send.mockClear();
    await recordInfraHealth("qorebridge", bridge(false, ["health_down"]), inBreak);
    expect(await recordInfraHealth("qorebridge", bridge(true), at(inBreak, 10))).toMatchObject({ alerted: null });
    expect(send).not.toHaveBeenCalled();
  });

  it("not reporting: nothing for a check never installed; one STALE after 15 min of silence, one when it reports again", async () => {
    expect(await checkInfraStale(NOON)).toEqual({});
    await recordInfraHealth("qorebridge", bridge(true), NOON);
    expect(await checkInfraStale(at(NOON, 14))).toEqual({});
    expect(await checkInfraStale(at(NOON, 16))).toEqual({ qorebridge: "STALE" });
    expect(send.mock.calls[0][0].subject).toBe("[VyX ops] qorebridge check is NOT REPORTING (vps-test)");
    expect(send.mock.calls[0][0].text).toContain("401 after a secret rotation");
    expect(await checkInfraStale(at(NOON, 30))).toEqual({});
    await recordInfraHealth("qorebridge", bridge(true), at(NOON, 31));
    expect(await checkInfraStale(at(NOON, 32))).toEqual({ qorebridge: "REPORTING" });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("not reporting through the daily break is not STALE until 15 min after it", async () => {
    await recordInfraHealth("database", { ...bridge(true), checkedAt: "2026-10-28T20:58:00Z" }, new Date("2026-10-28T20:58:00Z"));
    expect(await checkInfraStale(new Date("2026-10-28T21:40:00Z"))).toEqual({}); // in the break
    expect(await checkInfraStale(new Date("2026-10-28T22:10:00Z"))).toEqual({}); // 10 min after it
    expect(await checkInfraStale(new Date("2026-10-28T22:16:00Z"))).toEqual({ database: "STALE" });
  });
  it("a failed STALE e-mail is retried on the next minute", async () => {
    await recordInfraHealth("caddy", bridge(true), NOON);
    send.mockRejectedValueOnce(new Error("Resend send failed (500)"));
    expect(await checkInfraStale(at(NOON, 16))).toEqual({});
    expect(await checkInfraStale(at(NOON, 17))).toEqual({ caddy: "STALE" });
  });
});
