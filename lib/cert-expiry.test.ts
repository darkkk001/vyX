import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
const store = new Map<string, string>();
const fake = {
  set: vi.fn(async (k: string, v: string, _ex: string, _s: number, nx: string) => {
    if (nx === "NX" && store.has(k)) return null;
    store.set(k, v);
    return "OK";
  }),
  del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
};
vi.mock("@/lib/redis", () => ({ getRedis: () => fake }));
const send = vi.fn(async () => ({ usedMock: true }));
vi.mock("@/lib/email/adapter", () => ({ sendPlatformEmail: (...a: unknown[]) => send(...(a as [])) }));

import { certHosts, problemOf, runCertExpiryCheck, WARN_DAYS, type CertInfo } from "./cert-expiry";

const ok = (host: string, daysLeft: number, coversHost = true): CertInfo => ({
  host, daysLeft, coversHost, validTo: new Date(Date.now() + daysLeft * 86400000).toISOString(), subject: host, issuer: "Let's Encrypt", error: "",
});

beforeEach(() => { store.clear(); send.mockClear(); process.env.OPS_ALERT_EMAIL = "ops@example.test"; });

describe("cert-expiry", () => {
  it("checks every broker subdomain, every custom domain and www / feed / admin", () => {
    const hosts = certHosts([{ subdomain: "qoretrader", customDomain: "my.qoretrader.com" }, { subdomain: "TradeNextFX", customDomain: null }]);
    expect(hosts).toEqual(expect.arrayContaining([
      "qoretrader.vyxtrader.com", "my.qoretrader.com", "tradenextfx.vyxtrader.com",
      "www.vyxtrader.com", "vyxtrader.com", "feed.vyxtrader.com", "admin.vyxtrader.com",
    ]));
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it("flags expired, soon-to-expire, wrong-host and unreadable certificates, and passes a healthy one", () => {
    expect(WARN_DAYS).toBeGreaterThanOrEqual(14);
    expect(problemOf(ok("a", 80))).toBeNull();
    expect(problemOf(ok("a", WARN_DAYS - 1))).toMatch(/expires in/);
    expect(problemOf(ok("a", 13))).toMatch(/expires in 13 day/);
    expect(problemOf(ok("a", -1))).toMatch(/EXPIRED/);
    expect(problemOf(ok("a", 80, false))).toMatch(/does not cover/);
    expect(problemOf({ ...ok("a", 0), error: "ECONNRESET", daysLeft: null })).toMatch(/cannot read/);
  });

  it("the 2026-11-09 outage: an expired wildcard on the broker hosts sends one e-mail naming them, once a day", async () => {
    const inspect = async (h: string) => (h.endsWith(".vyxtrader.com") && h !== "www.vyxtrader.com" && h !== "feed.vyxtrader.com" ? { ...ok(h, -1), subject: "*.vyxtrader.com" } : ok(h, 61));
    const brokers = async () => [{ subdomain: "qoretrader", customDomain: null }];
    const now = new Date("2026-11-09T16:00:00Z");
    const r = await runCertExpiryCheck({ brokers, inspect, now });
    expect(r.emailed).toBe(true);
    expect(r.problems.map((p) => p.host).sort()).toEqual(["admin.vyxtrader.com", "qoretrader.vyxtrader.com"]);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = (send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }])[0];
    expect(msg.to).toBe("ops@example.test");
    expect(msg.subject).toContain("qoretrader.vyxtrader.com");
    expect(msg.text).toContain("vercel domains add");
    // a second run the same day does not repeat the e-mail; the next day it does
    expect((await runCertExpiryCheck({ brokers, inspect, now })).emailed).toBe(false);
    expect((await runCertExpiryCheck({ brokers, inspect, now: new Date("2026-11-10T07:00:00Z") })).emailed).toBe(true);
  });

  it("nothing wrong: no e-mail", async () => {
    const r = await runCertExpiryCheck({ brokers: async () => [{ subdomain: "qoretrader", customDomain: null }], inspect: async (h) => ok(h, 89) });
    expect(r.problems).toEqual([]);
    expect(r.emailed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed e-mail is retried by the next run", async () => {
    send.mockRejectedValueOnce(new Error("resend down"));
    const deps = { brokers: async () => [], inspect: async (h: string) => ok(h, 3), now: new Date("2026-11-09T07:00:00Z") };
    expect((await runCertExpiryCheck(deps)).emailed).toBe(false);
    expect((await runCertExpiryCheck(deps)).emailed).toBe(true);
  });
});
