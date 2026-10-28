import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The silence alert (owner 2026-10-28): a VPS check that used to report and has sent nothing for 15 minutes gets ONE
// "SILENT" ops e-mail; the next report sends the recovery (or its FAIL). Real Redis; the e-mail sender is mocked.
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";

vi.mock("@/lib/email/adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/adapter")>()),
  sendPlatformEmail: vi.fn().mockResolvedValue({ usedMock: true }),
}));

import { sendPlatformEmail } from "@/lib/email/adapter";
import { getRedis } from "@/lib/redis";
import { GET } from "@/app/api/internal/infra-silence/route";
import { checkInfraSilence, recordInfraHealth, type InfraReport } from "@/lib/infra-health";

const CRON = "silence-test-cron";
const saved: Record<string, string | undefined> = {};
const KEYS = ["CRON_SECRET", "OPS_ALERT_EMAIL"];
const send = vi.mocked(sendPlatformEmail);
const MIN = 60_000;

async function clearKeys() {
  await getRedis().del("infra-health:caddy", "infra-health:caddy:state", "infra-health:qorebridge", "infra-health:qorebridge:state");
}
beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.CRON_SECRET = CRON;
  process.env.OPS_ALERT_EMAIL = "ops1@example.test";
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
afterAll(clearKeys);

const report = (ok: boolean, reasons: string[] = []): InfraReport => ({ ok, reasons, checks: {}, checkedAt: new Date().toISOString(), host: "vps-test" });
const subjects = () => send.mock.calls.map((c) => c[0].subject);

describe("GET /api/internal/infra-silence", () => {
  it("needs the cron secret", async () => {
    expect((await GET(new NextRequest("https://test.local/api/internal/infra-silence"))).status).toBe(401);
    const res = await GET(new NextRequest("https://test.local/api/internal/infra-silence", { headers: { authorization: `Bearer ${CRON}` } }));
    expect(res.status).toBe(200);
  });
});

describe("checkInfraSilence", () => {
  it("a check that never reported raises nothing; a fresh report raises nothing", async () => {
    expect((await checkInfraSilence()).length).toBe(0);
    await recordInfraHealth("qorebridge", report(true));
    expect((await checkInfraSilence()).length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("OK, then 15 minutes without a report: ONE silent e-mail; the next report sends the recovery", async () => {
    const t0 = new Date(Date.now() - 16 * MIN);
    await recordInfraHealth("qorebridge", report(true), t0);
    const first = await checkInfraSilence();
    expect(first).toEqual([{ component: "qorebridge", alerted: true, emailed: true }]);
    expect(subjects()).toEqual(["[VyX ops] qorebridge check SILENT: no report from vps-test for 15 minutes"]);
    expect(send.mock.calls[0][0].text).toContain(`last report received at ${t0.toISOString()} (state OK)`);
    expect(send.mock.calls[0][0].text).toContain("Vercel challenge");
    // still silent: nothing more
    expect(await checkInfraSilence()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    // the check reports again
    const back = await recordInfraHealth("qorebridge", report(true));
    expect(back).toMatchObject({ state: "OK", alerted: "RECOVERED", emailed: true });
    expect(subjects()[1]).toBe("[VyX ops] qorebridge check recovered on vps-test");
  });

  it("FAIL (license state 2), then silent, then FAIL again: one e-mail each", async () => {
    await recordInfraHealth("qorebridge", report(false, ["qb_license_state is 2"]), new Date(Date.now() - 20 * MIN));
    expect(subjects()).toEqual(["[VyX ops] qorebridge check FAILED on vps-test"]);
    await checkInfraSilence();
    expect(subjects()[1]).toContain("SILENT");
    expect(send.mock.calls[1][0].text).toContain("(state FAIL)");
    await recordInfraHealth("qorebridge", report(false, ["qb_license_state is 3"]));
    expect(subjects()[2]).toBe("[VyX ops] qorebridge check FAILED on vps-test");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("the report gone (24 h TTL) still alerts once from the stored state", async () => {
    await recordInfraHealth("caddy", report(true));
    await getRedis().del("infra-health:caddy");
    await checkInfraSilence();
    expect(subjects()).toEqual(["[VyX ops] caddy check SILENT: no report from unknown host for 15 minutes"]);
    expect(send.mock.calls[0][0].text).toContain("no report for over 24 hours (last state OK)");
  });

  it("a failed e-mail puts the state back: the next run retries", async () => {
    await recordInfraHealth("qorebridge", report(true), new Date(Date.now() - 16 * MIN));
    send.mockRejectedValueOnce(new Error("smtp down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkInfraSilence()).toEqual([{ component: "qorebridge", alerted: true, emailed: false }]);
    expect(await getRedis().get("infra-health:qorebridge:state")).toBe("OK");
    expect(await checkInfraSilence()).toEqual([{ component: "qorebridge", alerted: true, emailed: true }]);
    expect(await getRedis().get("infra-health:qorebridge:state")).toBe("NO_REPORT");
  });
});
