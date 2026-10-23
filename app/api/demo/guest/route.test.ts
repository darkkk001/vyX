// Security re-audit 2026-10-23: POST /api/demo/guest, the only unauthenticated way to get an account. It exists on the
// demo tenant alone (a forged slug or broker header elsewhere is a 404), costs no new account for a visitor who already
// has a session, and is limited per address (Vercel's x-real-ip; a client-sent x-forwarded-for is ignored; an IPv6 /64
// is one address) and in total. Real rate limiter on the test Redis; account creation and sign-in mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getRedis } from "@/lib/redis";

vi.mock("@/lib/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-auth")>()),
  getAccountSession: vi.fn().mockResolvedValue(null),
  completeAccountLogin: vi.fn().mockResolvedValue("token"),
  accountSessionCookieOptions: vi.fn().mockResolvedValue({ httpOnly: true, path: "/" }),
}));
vi.mock("@/lib/demo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo")>()),
  getDemoBrokerId: vi.fn().mockResolvedValue("demo-broker"),
  createGuestAccount: vi.fn(async () => ({ id: `guest-${Math.random()}`, brokerId: "demo-broker" })),
  writeDemoState: vi.fn().mockResolvedValue(undefined),
}));

let savedSub: string | undefined;
beforeEach(async () => {
  savedSub = process.env.DEMO_BROKER_SUBDOMAIN;
  process.env.DEMO_BROKER_SUBDOMAIN = "qoretrader";
  const r = getRedis();
  const keys = await r.keys("ratelimit:demo-guest:*");
  if (keys.length) await r.del(...keys);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.DEMO_BROKER_SUBDOMAIN;
  else process.env.DEMO_BROKER_SUBDOMAIN = savedSub;
  vi.clearAllMocks();
});

const guest = async (headers: Record<string, string>) => {
  const { POST } = await import("./route");
  return POST(new NextRequest("https://qoretrader.vyxtrader.test/api/demo/guest", { method: "POST", headers }));
};
const DEMO = { "x-broker-slug": "qoretrader", "x-broker-id": "demo-broker" };
const created = async () => vi.mocked((await import("@/lib/demo")).createGuestAccount).mock.calls.length;

describe("demo guest: who gets an account", () => {
  it("not the demo tenant: another broker's slug, a forged demo slug with another broker id, or no headers -> 404, no account", async () => {
    for (const h of <Record<string, string>[]>[{ "x-broker-slug": "futurixglobal", "x-broker-id": "futurix" }, { "x-broker-slug": "qoretrader", "x-broker-id": "futurix" }, { "x-broker-slug": "qoretrader" }, {}]) {
      expect((await guest({ ...h, "x-real-ip": "198.51.100.1" })).status).toBe(404);
    }
    expect(await created()).toBe(0);
  });

  it("no demo tenant configured: 404 even with the right headers", async () => {
    delete process.env.DEMO_BROKER_SUBDOMAIN;
    expect((await guest({ ...DEMO, "x-real-ip": "198.51.100.2" })).status).toBe(404);
    expect(await created()).toBe(0);
  });

  it("a visitor who already has a session gets it back: no new account", async () => {
    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValueOnce({ accountId: "g1", brokerId: "demo-broker" } as never);
    const res = await guest({ ...DEMO, "x-real-ip": "198.51.100.3" });
    expect([res.status, (await res.json()).existing]).toEqual([200, true]);
    expect(await created()).toBe(0);
  });
});

describe("demo guest: limits", () => {
  it("3 per address per hour; rotating x-forwarded-for does not buy a fourth", async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await guest({ ...DEMO, "x-real-ip": "198.51.100.10", "x-forwarded-for": `203.0.113.${i}` })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    expect(await created()).toBe(3);
  });

  it("an IPv6 /64 is one address: rotating the host part does not buy a fourth", async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await guest({ ...DEMO, "x-real-ip": `2001:db8:1:2::${i + 1}` })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("no trusted address at all (or a malformed one) shares ONE bucket: it fails safe", async () => {
    const statuses = [];
    for (const ip of [undefined, "not-an-ip", "<script>", undefined]) statuses.push((await guest({ ...DEMO, ...(ip ? { "x-real-ip": ip } : {}), "x-forwarded-for": "203.0.113.50" })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("the global ceiling holds across addresses", async () => {
    const { GUEST_GLOBAL_PER_HOUR } = await import("@/lib/demo");
    await getRedis().set("ratelimit:demo-guest:global", String(GUEST_GLOBAL_PER_HOUR), "EX", 3600);
    expect((await guest({ ...DEMO, "x-real-ip": "198.51.100.99" })).status).toBe(429);
    expect(await created()).toBe(0);
  });
});
