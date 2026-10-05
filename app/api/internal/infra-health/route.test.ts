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
import { readInfraSummary } from "@/lib/infra-health";

const SECRET = "infra-test-secret";
const saved: Record<string, string | undefined> = {};
const KEYS = ["INTERNAL_SERVICE_SECRET", "OPS_ALERT_EMAIL", "TRADING_CORE_URL", "GATEWAY_URL"];
const send = vi.mocked(sendPlatformEmail);

async function clearKeys() {
  await getRedis().del("infra-health:caddy", "infra-health:caddy:state");
}
beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.INTERNAL_SERVICE_SECRET = SECRET;
  process.env.OPS_ALERT_EMAIL = "ops1@example.test, ops2@example.test";
  send.mockReset();
  send.mockResolvedValue({ usedMock: true });
  await clearKeys();
});
afterEach(() => {
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

describe("alerts: one per state change", () => {
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
    for (let i = 0; i < 3; i++) expect(await (await post(report(false, ["still bad"]))).json()).toMatchObject({ state: "FAIL", alerted: null });
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

describe("feed health", () => {
  async function feedHealth() {
    vi.mocked(getAdminSession).mockResolvedValue({ role: "BROKER_ADMIN", brokerId: "b_test", adminId: "a_test" } as never);
    process.env.TRADING_CORE_URL = "http://127.0.0.1:1";
    process.env.GATEWAY_URL = "http://127.0.0.1:1";
    const { GET } = await import("@/app/api/manage/feed-health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    return (await res.json()).infra.caddy;
  }
  it("NO_REPORT when nothing was ever reported", async () => {
    expect(await feedHealth()).toMatchObject({ state: "NO_REPORT", checkedAt: null });
  });
  it("OK, then FAIL with the reasons", async () => {
    await post(report(true));
    expect(await feedHealth()).toMatchObject({ state: "OK" });
    await post(report(false, ["service SERVICE_PAUSED"]));
    expect(await feedHealth()).toMatchObject({ state: "FAIL", reasons: ["service SERVICE_PAUSED"] });
  });
  it("NO_REPORT when the last report is older than 15 minutes", async () => {
    await post(report(true));
    expect((await readInfraSummary("caddy", Date.now() + 16 * 60 * 1000)).state).toBe("NO_REPORT");
    expect((await readInfraSummary("caddy", Date.now() + 14 * 60 * 1000)).state).toBe("OK");
  });
});
