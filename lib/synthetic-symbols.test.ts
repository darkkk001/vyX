import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Synthetic symbols (2026-09-28): the one reserved prefix, the case rule, and the isolation of v* symbols -- the
// backoffice Symbols API, both candle routes and feed health hide / refuse them for every broker but zzshadowbot;
// the order / hedge-order / alert routes resolve "vGOLD" by its exact name. Scratch DB for the route tests.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
vi.mock("@/lib/candles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/candles")>()),
  fetchCandleHistory: vi.fn().mockResolvedValue({ candles: [{ t: 1 }], source: "test" }),
}));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { SYNTH_PREFIX, SHADOWBOT_SUBDOMAIN, canonicalSymbolName, isSyntheticSymbol } from "@/lib/synthetic-symbols";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const D = (v: string | number) => new Prisma.Decimal(v);

describe("the reserved prefix", () => {
  it("is ONE value: the web constant equals the engine's", () => {
    const rust = read("engine/market-data/src/synthetic.rs").match(/pub const SYNTH_PREFIX: &str = "([^"]*)";/);
    expect(rust?.[1]).toBe(SYNTH_PREFIX);
    expect(SYNTH_PREFIX).toBe("v");
  });
  it("is a case-sensitive LEADING match only", () => {
    for (const s of ["vGOLD", "vEUR", "vGBP", "vJPY", "vIDX"]) expect(isSyntheticSymbol(s)).toBe(true);
    for (const s of ["VIX", "VOD", "XAUUSD", "EURUSD", "US30", "XAUUSDv", "EURvUSD", "", " vGOLD", null, undefined]) expect(isSyntheticSymbol(s)).toBe(false);
  });
  it("lookups keep a synthetic name's case and upper-case everything else as before", () => {
    expect(canonicalSymbolName(" vGOLD ")).toBe("vGOLD");
    expect(canonicalSymbolName("vIDX")).toBe("vIDX");
    expect(canonicalSymbolName("xauusd")).toBe("XAUUSD");
    expect(canonicalSymbolName("vix")).toBe("VIX"); // not the synthetic form: upper-cased exactly as before
    expect(canonicalSymbolName("VGOLD")).toBe("VGOLD");
  });
  it("the real price-feed path on the web is untouched (no synthetic handling in it)", () => {
    for (const f of ["lib/price-feed.ts", "app/api/internal/price-feed/route.ts", "app/api/internal/price-feed/[payload]/route.ts"]) {
      expect(read(f)).not.toMatch(/synth|SYNTH|isSyntheticSymbol/);
    }
  });
});

let dbReachable = false;
const brokers: string[] = [];
const symbols: string[] = [];
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("synthetic-symbols.test.ts: DB unreachable, skipping DB tests");
  }
});
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

// a synthetic symbol unique to this run ("v" + upper-case hex), and a real one
async function fixture() {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const vName = `vT${suffix}`;
  const realName = `RT${suffix}`;
  symbols.push(vName, realName);
  const v = await prisma.symbol.create({ data: { name: vName, baseCurrency: vName, quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  const real = await prisma.symbol.create({ data: { name: realName, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  await prisma.livePrice.create({ data: { symbol: vName, bid: D("100.00"), ask: D("100.00"), tickAt: new Date() } });
  // the shadow-bot tenant (created if this scratch DB has none yet) and an ordinary broker
  let zz = await prisma.broker.findUnique({ where: { subdomain: SHADOWBOT_SUBDOMAIN } });
  if (!zz) {
    zz = await prisma.broker.create({ data: { name: `zz ${suffix}`, subdomain: SHADOWBOT_SUBDOMAIN } });
    brokers.push(zz.id);
  }
  const other = await prisma.broker.create({ data: { name: `Other ${suffix}`, subdomain: `other-${suffix.toLowerCase()}` } });
  brokers.push(other.id);
  return { v, real, zz, other };
}
async function adminOf(brokerId: string) {
  const a = await prisma.adminUser.create({ data: { brokerId, email: `s-${randomUUID().slice(0, 8)}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  if (!brokers.includes(brokerId)) brokers.push(brokerId);
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: "BROKER_ADMIN", brokerId } as never);
  return a;
}
async function call(handler: unknown, url: string, method = "GET", body?: unknown) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest) => Promise<Response>)(req);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("isolation (a): the backoffice Symbols API", () => {
  it("lists a v* symbol only to zzshadowbot and refuses to configure it for anyone else", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    const { GET, PATCH } = await import("@/app/api/manage/symbols/route");
    await adminOf(f.other.id);
    const otherList = (await call(GET, "/api/manage/symbols")).json as { symbolName: string }[];
    expect(otherList.some((r) => r.symbolName === f.v.name)).toBe(false);
    expect(otherList.some((r) => r.symbolName === f.real.name)).toBe(true);
    const refused = await call(PATCH, "/api/manage/symbols", "PATCH", { symbolId: f.v.id, enabled: true });
    expect(refused.status).toBe(400);
    expect(await prisma.brokerSymbol.count({ where: { brokerId: f.other.id, symbolId: f.v.id } })).toBe(0);
    await adminOf(f.zz.id);
    const zzList = (await call(GET, "/api/manage/symbols")).json as { symbolName: string }[];
    expect(zzList.some((r) => r.symbolName === f.v.name)).toBe(true);
  });
});

describe("isolation (b): candle history", () => {
  it("another broker's trader and staff get an empty history for a v* symbol; zzshadowbot's get it", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    const trade = await import("@/app/api/trade/candles/route");
    const manage = await import("@/app/api/manage/candles/route");
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: "x", brokerId: f.other.id } as never);
    expect((await call(trade.GET, `/api/trade/candles?symbol=${f.v.name}&tf=M1`)).json).toEqual([]);
    expect((await call(trade.GET, `/api/trade/candles?symbol=${f.real.name}&tf=M1`)).json).toHaveLength(1);
    await adminOf(f.other.id);
    expect((await call(manage.GET, `/api/manage/candles?symbol=${f.v.name}&tf=M1`)).json).toEqual([]);
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: "x", brokerId: f.zz.id } as never);
    expect((await call(trade.GET, `/api/trade/candles?symbol=${f.v.name}&tf=M1`)).json).toHaveLength(1);
  });
});

describe("isolation (c): feed health", () => {
  it("drops v* rows and the synth counters for every broker but zzshadowbot", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    const engine = {
      ticks_in: 5, queue_len: 2,
      per_symbol: [{ symbol: "XAUUSD", ticks_60s: 3, last_tick_age_ms: 10, bid: "1", ask: "1" }, { symbol: f.v.name, ticks_60s: 9, last_tick_age_ms: 5, bid: "1", ask: "1" }],
      synth: { ticks_in: 9 },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("feed-stats") ? engine : {}), { status: 200 })) as typeof fetch;
    try {
      const { GET } = await import("@/app/api/manage/feed-health/route");
      await adminOf(f.other.id);
      const other = (await (GET as () => Promise<Response>)()).json();
      const o = (await other) as { feedStats: { per_symbol: { symbol: string }[]; synth?: unknown; ticks_in: number } };
      expect(o.feedStats.per_symbol.map((r) => r.symbol)).toEqual(["XAUUSD"]);
      expect(o.feedStats.synth).toBeUndefined();
      expect(o.feedStats.ticks_in).toBe(5);
      await adminOf(f.zz.id);
      const z = (await (await (GET as () => Promise<Response>)()).json()) as { feedStats: { per_symbol: { symbol: string }[]; synth?: { ticks_in: number } } };
      expect(z.feedStats.per_symbol.map((r) => r.symbol)).toContain(f.v.name);
      expect(z.feedStats.synth?.ticks_in).toBe(9);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("orders resolve a synthetic name by its exact case", () => {
  it("a LIMIT order on vT... is placed on the synthetic symbol (it used to be upper-cased and never found)", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    await prisma.brokerSymbol.create({ data: { brokerId: f.other.id, symbolId: f.v.id, enabled: true } });
    const g = await prisma.group.create({ data: { brokerId: f.other.id, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: "B_BOOK", isClientSelectable: true } });
    const n = `6${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "6")}`;
    const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: f.other.id, accountNumber: n, email: `v-${n}@t.local`, passwordHash: "x", fullName: "V", accountMode: "LIVE", balance: D(100000), leverage: 100 } });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: f.other.id } as never);
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", { symbol: f.v.name, side: "BUY", type: "LIMIT", volume: "0.10", price: "95.00", idempotencyKey: `v:${randomUUID()}` });
    expect(r.status).toBe(201);
    expect((await prisma.order.findFirstOrThrow({ where: { accountId: acc.id } })).symbolId).toBe(f.v.id);
  });
});
