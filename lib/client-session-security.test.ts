import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Trader's Room security batch (owner 2026-11-05): idle and absolute session limits, sign-out that really ends a session,
// login limits that say nothing about who is registered. Redis is an in-memory stand-in that honours expiry, so the clock
// can be moved past each limit.
const store = new Map<string, { v: string | Set<string>; at: number | null }>();
const live = (k: string) => {
  const e = store.get(k);
  if (e && e.at !== null && Date.now() >= e.at) { store.delete(k); return undefined; }
  return e;
};
const fake = {
  get: async (k: string) => (live(k)?.v as string | undefined) ?? null,
  mget: async (...ks: string[]) => ks.map((k) => (live(k)?.v as string | undefined) ?? null),
  set: async (k: string, v: string, _ex?: string, s?: number) => { store.set(k, { v, at: s ? Date.now() + s * 1000 : null }); return "OK"; },
  del: async (...ks: string[]) => { for (const k of ks) store.delete(k); return ks.length; },
  sadd: async (k: string, m: string) => { const e = live(k); const set = (e?.v as Set<string>) ?? new Set<string>(); set.add(m); store.set(k, { v: set, at: null }); return 1; },
  srem: async (k: string, ...ms: string[]) => { const set = live(k)?.v as Set<string> | undefined; for (const m of ms) set?.delete(m); return ms.length; },
  smembers: async (k: string) => [...((live(k)?.v as Set<string>) ?? [])],
  sismember: async (k: string, m: string) => (((live(k)?.v as Set<string>) ?? new Set()).has(m) ? 1 : 0),
  incr: async (k: string) => { const e = live(k); const n = Number(e?.v ?? 0) + 1; store.set(k, { v: String(n), at: e?.at ?? null }); return n; },
  expire: async (k: string, s: number) => { const e = live(k); if (e) e.at = Date.now() + s * 1000; return 1; },
};
vi.mock("@/lib/redis", () => ({ getRedis: () => fake }));

const jar = { token: "", broker: "" };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (jar.token ? { value: jar.token } : undefined), has: () => Boolean(jar.token) }),
  headers: async () => ({ get: (n: string) => (n === "x-broker-id" ? jar.broker : n === "host" ? "t.local" : null) }),
}));
vi.mock("@/lib/email/adapter", () => ({ sendBrokerEmail: vi.fn().mockResolvedValue({ usedMock: true }) }));

const MIN = 60_000;
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let clientId = "";
const email = `sec-${s}@t.local`;
const PASSWORD = "Correct-horse-1";

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("client-session-security.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Sec ${s}`, subdomain: `sec-${s}` } })).id;
  clientId = (await prisma.client.create({ data: { brokerId, email, passwordHash: await bcrypt.hash(PASSWORD, 4), fullName: "Sec", emailVerifiedAt: new Date() } })).id;
  jar.broker = brokerId;
});
beforeEach(() => { store.clear(); jar.token = ""; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T08:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

const auth = () => import("@/lib/client-auth");
async function signIn() {
  const { createClientSession } = await auth();
  jar.token = await createClientSession({ clientId, brokerId }, true, { userAgent: "t", ip: "1.1.1.1" });
  return jar.token;
}
const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

describe("idle limit", () => {
  it("background reads do not hold it off; the session ends at the broker's idle limit", async () => {
    if (!dbReachable) return;
    const { getClientSession } = await auth();
    await signIn();
    for (let i = 0; i < 29; i++) { later(MIN); expect(await getClientSession({ activity: false })).not.toBeNull(); }
    later(MIN + 1000);
    expect(await getClientSession({ activity: false })).toBeNull();
  });
  it("real activity holds it off, past the limit", async () => {
    if (!dbReachable) return;
    const { getClientSession } = await auth();
    await signIn();
    for (let i = 0; i < 6; i++) { later(20 * MIN); expect(await getClientSession()).not.toBeNull(); }
  });
  it("the broker's own limit applies at the next sign-in", async () => {
    if (!dbReachable) return;
    const { getClientSession } = await auth();
    await prisma.broker.update({ where: { id: brokerId }, data: { clientIdleMinutes: 5 } });
    await signIn();
    later(6 * MIN);
    expect(await getClientSession({ activity: false })).toBeNull();
    await prisma.broker.update({ where: { id: brokerId }, data: { clientIdleMinutes: 30 } });
  });
  it("a broker's setting must be whole minutes from 5 to 240", async () => {
    const { parseIdleMinutes } = await auth();
    expect([parseIdleMinutes(5), parseIdleMinutes("240"), parseIdleMinutes(30)]).toEqual([5, 240, 30]);
    expect([parseIdleMinutes(4), parseIdleMinutes(241), parseIdleMinutes(7.5), parseIdleMinutes(""), parseIdleMinutes(null)]).toEqual([null, null, null, null, null]);
  });
});

describe("absolute limit", () => {
  it("ends the session 12 hours after sign-in however active it is", async () => {
    if (!dbReachable) return;
    const { getClientSession } = await auth();
    await signIn();
    for (let i = 0; i < 47; i++) { later(15 * MIN); expect(await getClientSession()).not.toBeNull(); }
    later(16 * MIN);
    expect(await getClientSession()).toBeNull();
  });
  it("a session from before the limits is not thrown out by the release; its clocks start at the first read", async () => {
    if (!dbReachable) return;
    const { getClientSession } = await auth();
    jar.token = `old-${s}`;
    await fake.set(`client_session:${jar.token}`, JSON.stringify({ clientId, brokerId, sessionId: "oldid" }), "EX", 86400);
    expect(await getClientSession({ activity: false })).toMatchObject({ clientId });
    later(31 * MIN);
    expect(await getClientSession({ activity: false })).toBeNull();
  });
});

describe("sign out", () => {
  it("POST /api/portal/logout ends the session on the server and drops it from Active sessions", async () => {
    if (!dbReachable) return;
    const { getClientSession, listClientSessions, createClientSession } = await auth();
    const other = await createClientSession({ clientId, brokerId }, true);
    const token = await signIn();
    expect(await listClientSessions(clientId, undefined)).toHaveLength(2);
    const { POST } = await import("@/app/api/portal/logout/route");
    const res = await POST(new NextRequest("https://t.local/api/portal/logout", { method: "POST", headers: { cookie: `vyx_client_session=${token}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("vyx_client_session=;");
    expect(await getClientSession()).toBeNull(); // the old cookie is dead even if a browser kept it
    expect(await listClientSessions(clientId, undefined)).toHaveLength(1);
    jar.token = other;
    expect(await getClientSession()).not.toBeNull(); // another device stays signed in
  });
});

describe("login limits", () => {
  const login = async (address: string, password: string, ip = "9.9.9.9") => {
    const { POST } = await import("@/app/api/portal/login/route");
    const r = await POST(new NextRequest("https://t.local/api/portal/login", { method: "POST", headers: { "content-type": "application/json", "x-broker-id": brokerId, "x-real-ip": ip }, body: JSON.stringify({ email: address, password }) }));
    return { status: r.status, body: await r.json() };
  };
  it("a wrong password and an unknown address answer the same, and the unknown one still does the password work", async () => {
    if (!dbReachable) return;
    const spy = vi.spyOn(bcrypt, "compare");
    const wrong = await login(email, "nope-nope-1", "9.9.9.1");
    const unknown = await login(`nobody-${s}@t.local`, "nope-nope-1", "9.9.9.2");
    expect(unknown).toEqual(wrong);
    expect(wrong).toEqual({ status: 401, body: { error: "invalid email or password" } });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
  it("five tries a minute from one IP on one address; another IP is not blocked by that", async () => {
    if (!dbReachable) return;
    for (let i = 0; i < 5; i++) expect((await login(email, "nope-nope-1")).status).toBe(401);
    expect((await login(email, "nope-nope-1")).status).toBe(429);
    expect((await login(email, PASSWORD, "8.8.8.8")).status).toBe(200);
  });
  it("one IP walking through addresses stops at 30 a minute", async () => {
    if (!dbReachable) return;
    for (let i = 0; i < 30; i++) expect((await login(`a${i}-${s}@t.local`, "x")).status).toBe(401);
    expect((await login(`b-${s}@t.local`, "x")).status).toBe(429);
  });
  it("many IPs on one address lock it after 20 failures, registered or not, and the same answer either way", async () => {
    if (!dbReachable) return;
    for (const address of [email, `ghost-${s}@t.local`]) {
      for (let i = 0; i < 20; i++) expect((await login(address, "nope-nope-1", `7.7.${i}.1`)).status).toBe(401);
      expect(await login(address, "nope-nope-1", "6.6.6.6")).toEqual({ status: 429, body: { error: "too many attempts, try again shortly" } });
    }
  });
  it("a good sign-in clears the failures", async () => {
    if (!dbReachable) return;
    for (let i = 0; i < 19; i++) await login(email, "nope-nope-1", `5.5.${i}.1`);
    expect((await login(email, PASSWORD, "4.4.4.4")).status).toBe(200);
    expect((await login(email, "nope-nope-1", "3.3.3.3")).status).toBe(401);
  });
});

describe("human check (Turnstile)", () => {
  const siteverify = vi.fn();
  beforeEach(() => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    siteverify.mockReset();
    siteverify.mockResolvedValue(new Response(JSON.stringify({ success: true })));
    vi.stubGlobal("fetch", siteverify);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const setBroker = (humanCheckEnabled: boolean, crmEnabled = true) => prisma.broker.update({ where: { id: brokerId }, data: { humanCheckEnabled, crmEnabled } });
  const login = async (address: string, password: string, ip: string, turnstileToken?: string) => {
    const { POST } = await import("@/app/api/portal/login/route");
    const r = await POST(new NextRequest("https://t.local/api/portal/login", { method: "POST", headers: { "content-type": "application/json", "x-broker-id": brokerId, "x-real-ip": ip }, body: JSON.stringify({ email: address, password, turnstileToken }) }));
    return { status: r.status, body: await r.json() };
  };

  // owner 2026-11-13: every sign-in sends the check (it used to start after three failures)
  it("every sign-in without a token is refused, for a registered or an unknown address alike", async () => {
    if (!dbReachable) return;
    await setBroker(true);
    for (const [address, ip] of [[email, "2.2.2.1"], [`none-${s}@t.local`, "2.2.2.2"]]) {
      expect(await login(address, "nope-nope-1", ip)).toEqual({ status: 401, body: { error: "complete the check to continue", code: "HUMAN_CHECK_REQUIRED", siteKey: "site-key" } });
    }
    expect(siteverify).not.toHaveBeenCalled();
    await setBroker(false, false);
  });
  it("the right password without a token is refused; with a good token it signs in", async () => {
    if (!dbReachable) return;
    await setBroker(true);
    expect((await login(email, PASSWORD, "2.2.3.1")).body.code).toBe("HUMAN_CHECK_REQUIRED");
    expect((await login(email, PASSWORD, "2.2.3.1", "tok")).status).toBe(200);
    expect(JSON.parse(siteverify.mock.calls[0][1].body)).toMatchObject({ secret: "secret-key", response: "tok" });
    await setBroker(false, false);
  });
  it("a refused token stops the sign-in; Cloudflare being down does not lock clients out", async () => {
    if (!dbReachable) return;
    await setBroker(true);
    siteverify.mockResolvedValue(new Response(JSON.stringify({ success: false })));
    expect((await login(email, PASSWORD, "2.2.4.1", "bad")).body.code).toBe("HUMAN_CHECK_REQUIRED");
    siteverify.mockRejectedValue(new Error("down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await login(email, PASSWORD, "2.2.4.1", "any")).status).toBe(200);
    quiet.mockRestore();
    await setBroker(false, false);
  });
  it("switched off, or a broker without the CRM module, never asks", async () => {
    if (!dbReachable) return;
    const { humanCheckSiteKey } = await import("@/lib/turnstile");
    await setBroker(false, true);
    expect(await humanCheckSiteKey(brokerId)).toBeNull();
    await setBroker(true, false);
    expect(await humanCheckSiteKey(brokerId)).toBeNull();
    await setBroker(true, true);
    expect(await humanCheckSiteKey(brokerId)).toBe("site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(await humanCheckSiteKey(brokerId)).toBeNull();
    await setBroker(false, false);
  });
});

describe("the room's wiring", () => {
  const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  it("room API reads are background reads; expiry lands on the sign-in notice; the menu signs out on the server", () => {
    expect(src("lib/room/context.ts")).toContain("getClientSession({ activity: false })");
    expect(src("components/room/RoomData.tsx")).toContain('"/login?signedOut=1"');
    expect(src("app/(broker)/room/(shell)/layout.tsx")).toContain('"/login?signedOut=1"');
    expect(src("components/room/UserMenu.tsx")).toContain('fetch("/api/portal/logout", { method: "POST" })');
    expect(src("components/room/RoomHeader.tsx")).toContain("<UserMenu />");
  });
});
