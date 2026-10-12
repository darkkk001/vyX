import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { cleanDemoRedis, createOtherBroker, D, seedDemoTenant } from "@/lib/demo-test-fixtures";
import { clientIpOf, createGuestAccount, GUEST_GLOBAL_PER_HOUR, GUEST_NUMBER_MAX, GUEST_NUMBER_MIN, GUEST_PER_IP_PER_HOUR, GUEST_START_BALANCE, isGuestAccountNumber, nextGuestNumber, readDemoState } from "@/lib/demo";

// The guest door: POST /api/demo/guest only on the demo tenant, the rate limits, the reserved number range, the address the
// limit counts, and what a fresh guest looks like. Redis is the local one (db 10).
const session = vi.hoisted(() => ({ current: null as null | { accountId: string; brokerId: string } }));
vi.mock("@/lib/account-auth", async (orig) => ({ ...(await orig<typeof import("@/lib/account-auth")>()), getAccountSession: async () => session.current }));

let demo: Awaited<ReturnType<typeof seedDemoTenant>>;
let other: Awaited<ReturnType<typeof createOtherBroker>>;
let POST: (r: NextRequest) => Promise<Response>;

beforeAll(async () => {
  demo = await seedDemoTenant();
  other = await createOtherBroker();
  POST = (await import("@/app/api/demo/guest/route")).POST;
}, 120_000);
afterAll(async () => {
  await cleanDemoRedis();
  delete process.env.DEMO_BROKER_SUBDOMAIN;
});

const guestRequest = (headers: Record<string, string>) => new NextRequest("https://demo.test/api/demo/guest", { method: "POST", headers });
const demoHeaders = (ip: string) => ({ "x-broker-slug": "qoredemo", "x-broker-id": demo.broker.id, "x-real-ip": ip, "user-agent": "vitest" });

describe("the guest route", () => {
  it("answers 404 on any host that is not the demo tenant, and creates nothing", async () => {
    const before = await prisma.account.count();
    const a = await POST(guestRequest({ "x-broker-slug": other.broker.subdomain, "x-broker-id": other.broker.id, "x-real-ip": "10.0.0.1" }));
    expect(a.status).toBe(404);
    const b = await POST(guestRequest({ "x-real-ip": "10.0.0.2" })); // no broker at all
    expect(b.status).toBe(404);
    // the slug of the demo with somebody else's broker id (a forged header on a host with no resolution)
    const c = await POST(guestRequest({ "x-broker-slug": "qoredemo", "x-broker-id": other.broker.id, "x-real-ip": "10.0.0.3" }));
    expect(c.status).toBe(404);
    expect(await prisma.account.count()).toBe(before);
  });

  it("creates one guest: DEMO account in the reserved range, the Demo group, 10,000 USD by an ADJUSTMENT row, a session cookie", async () => {
    const res = await POST(guestRequest(demoHeaders("203.0.113.10")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; existing: boolean; serverNow: number };
    expect(body.ok).toBe(true);
    expect(body.existing).toBe(false);
    expect(Math.abs(body.serverNow - Date.now())).toBeLessThan(10_000);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("vyx_trade_session=");
    expect(cookie.toLowerCase()).toContain("httponly");

    const guests = await prisma.account.findMany({ where: { brokerId: demo.broker.id }, include: { group: true, transactions: true } });
    expect(guests).toHaveLength(1);
    const g = guests[0];
    expect(isGuestAccountNumber(g.accountNumber)).toBe(true);
    expect(Number(g.accountNumber)).toBeGreaterThanOrEqual(GUEST_NUMBER_MIN);
    expect(Number(g.accountNumber)).toBeLessThanOrEqual(GUEST_NUMBER_MAX);
    expect(g.accountMode).toBe("DEMO");
    expect(g.currency).toBe("USD");
    expect(g.clientId).toBeNull();
    expect(g.group.name).toBe("Demo");
    expect(g.group.category).toBe("B_BOOK");
    expect(g.email).toBe(`guest-${g.accountNumber}@demo.invalid`);
    expect(g.balance.equals(D(GUEST_START_BALANCE))).toBe(true);
    expect(g.transactions).toHaveLength(1);
    expect(g.transactions[0]).toMatchObject({ type: "ADJUSTMENT", status: "COMPLETED" });
    expect(g.transactions[0].amount.equals(D(10000))).toBe(true);
    // the password is unusable: no plausible guess opens it
    const bcrypt = (await import("bcryptjs")).default;
    expect(await bcrypt.compare("password", g.passwordHash)).toBe(false);
    // the replay cursor exists, with nothing to replay
    expect(await readDemoState(g.id)).toMatchObject({ w: 0 });
    // a login record carries the address
    const login = await prisma.loginEvent.findFirst({ where: { accountId: g.id } });
    expect(login?.ipAddress).toBe("203.0.113.10");
  });

  it("a visitor who already holds a session gets it back and costs no account", async () => {
    const some = await prisma.account.findFirstOrThrow({ where: { brokerId: demo.broker.id } });
    session.current = { accountId: some.id, brokerId: demo.broker.id };
    const before = await prisma.account.count({ where: { brokerId: demo.broker.id } });
    const res = await POST(guestRequest(demoHeaders("203.0.113.11")));
    expect(res.status).toBe(200);
    expect((await res.json()).existing).toBe(true);
    expect(await prisma.account.count({ where: { brokerId: demo.broker.id } })).toBe(before);
    session.current = null;
  });

  it(`allows ${GUEST_PER_IP_PER_HOUR} new guests per address per hour and refuses the next one with 429`, async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < GUEST_PER_IP_PER_HOUR; i++) expect((await POST(guestRequest(demoHeaders(ip)))).status).toBe(200);
    const refused = await POST(guestRequest(demoHeaders(ip)));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("3600");
    // another address is not affected
    expect((await POST(guestRequest(demoHeaders("198.51.100.78")))).status).toBe(200);
  });

  it("a client-supplied x-forwarded-for does not buy a fresh allowance", async () => {
    const ip = "198.51.100.90";
    for (let i = 0; i < GUEST_PER_IP_PER_HOUR; i++) await POST(guestRequest(demoHeaders(ip)));
    const spoofed = await POST(guestRequest({ ...demoHeaders(ip), "x-forwarded-for": "1.2.3.4, 5.6.7.8" }));
    expect(spoofed.status).toBe(429);
  });

  it(`stops at ${GUEST_GLOBAL_PER_HOUR} new guests per hour in total, whatever the address`, async () => {
    await getRedis().set("ratelimit:demo-guest:global", String(GUEST_GLOBAL_PER_HOUR), "EX", 3600);
    const before = await prisma.account.count({ where: { brokerId: demo.broker.id } });
    const res = await POST(guestRequest(demoHeaders("192.0.2.200")));
    expect(res.status).toBe(429);
    expect(await prisma.account.count({ where: { brokerId: demo.broker.id } })).toBe(before);
    await getRedis().del("ratelimit:demo-guest:global");
  });
});

describe("the address the limit counts", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
  it("is x-real-ip (set by Vercel), never the first hop of x-forwarded-for", () => {
    expect(clientIpOf(h({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "9.9.9.9, 203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIpOf(h({ "x-forwarded-for": "9.9.9.9" }))).toBe("unknown");
    expect(clientIpOf(h({ "x-vercel-forwarded-for": "203.0.113.6" }))).toBe("203.0.113.6");
    expect(clientIpOf(h({}))).toBe("unknown");
    expect(clientIpOf(h({ "x-real-ip": "not an ip" }))).toBe("unknown");
  });
  it("counts an IPv6 visitor per /64, so rotating the host part buys nothing", () => {
    const a = clientIpOf(h({ "x-real-ip": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }));
    const b = clientIpOf(h({ "x-real-ip": "2001:db8:1:2:1111:2222:3333:4444" }));
    const c = clientIpOf(h({ "x-real-ip": "2001:db8:1:3:1111:2222:3333:4444" }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("guest numbers", () => {
  it("are MAX within the range + 1, never outside it, and an account outside the range is ignored", async () => {
    const top = await prisma.account.aggregate({ _max: { accountNumber: true }, where: { accountNumber: { gte: "48000000", lt: "49000000" } } });
    const next = await nextGuestNumber(prisma);
    expect(Number(next)).toBe(Number(top._max.accountNumber) + 1);
    // a real account far above the range does not move the guest counter
    expect(Number(next)).toBeLessThan(49_000_000);
  });
  it("at the top of the range the next number is a free number INSIDE the range", async () => {
    const g = await createGuestAccount();
    expect(g).not.toBeNull();
    await prisma.account.update({ where: { id: g!.id }, data: { accountNumber: String(GUEST_NUMBER_MAX) } });
    const n = await nextGuestNumber(prisma);
    expect(isGuestAccountNumber(n)).toBe(true);
    expect(n).not.toBe(String(GUEST_NUMBER_MAX));
    // and a guest can still be created: it lands somewhere inside the range
    const again = await createGuestAccount();
    expect(isGuestAccountNumber(again!.accountNumber)).toBe(true);
    expect(again!.accountNumber).not.toBe(String(GUEST_NUMBER_MAX));
  });
  it("the range test is exact", () => {
    for (const ok of ["48000000", "48000001", "48999999"]) expect(isGuestAccountNumber(ok)).toBe(true);
    for (const bad of ["47999999", "49000000", "4800000", "480000000", "48a00000", "", null, undefined, "50005710", "49990001"]) expect(isGuestAccountNumber(bad as string)).toBe(false);
  });
  it("creating a guest on a tenant that is not configured returns null and creates nothing", async () => {
    const saved = process.env.DEMO_BROKER_SUBDOMAIN;
    delete process.env.DEMO_BROKER_SUBDOMAIN;
    const { resetDemoBrokerCache } = await import("@/lib/demo");
    resetDemoBrokerCache();
    const before = await prisma.account.count();
    expect(await createGuestAccount()).toBeNull();
    expect(await prisma.account.count()).toBe(before);
    process.env.DEMO_BROKER_SUBDOMAIN = saved;
    resetDemoBrokerCache();
  });
});
