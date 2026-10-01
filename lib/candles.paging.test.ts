import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { candleBeforeFrom, fetchCandleHistory } from "./candles";

// web6 (owner 2026-10-01, issue 17: "M1/M5 history before 30 Sep is missing"): the candle routes page back with
// ?before=<ms> and up to 1500 bars, passed through to the engine's /internal/candles paging; Neon (and the Neon
// fallback) honour the same bound. Auth and tenant rules are unchanged.
vi.mock("@/lib/account-auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/account-auth")>()), getAccountSession: vi.fn() }));

let ready = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    ready = true;
  } catch {
    console.warn("candles.paging.test.ts: DB unreachable, skipping DB cases");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});
const ENV = { ...process.env };
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.MARKET_DATA_URL = ENV.MARKET_DATA_URL;
  process.env.MARKET_DATA_READ_SECRET = ENV.MARKET_DATA_READ_SECRET;
  process.env.MARKET_DATA_VPS_SYMBOLS = ENV.MARKET_DATA_VPS_SYMBOLS;
  for (const k of ["MARKET_DATA_URL", "MARKET_DATA_READ_SECRET", "MARKET_DATA_VPS_SYMBOLS"]) if (ENV[k] === undefined) delete process.env[k];
});

const T0 = Date.UTC(2026, 8, 20, 10, 0); // 2026-09-20 10:00 UTC
async function seedNeon(symbol: string, n: number) {
  await prisma.candle.createMany({
    data: Array.from({ length: n }, (_, i) => ({ symbol, timeframe: "M1" as const, bucketStart: new Date(T0 + i * 60_000), open: 1, high: 2, low: 1, close: 1 + i / 1000 })),
  });
}
const iso = (rows: unknown[]) => (rows as { bucketStart: Date | string }[]).map((r) => new Date(r.bucketStart).toISOString());

describe("candleBeforeFrom", () => {
  it("absent = newest page; a positive integer = that instant; anything else is refused", () => {
    expect(candleBeforeFrom(null)).toBeNull();
    expect(candleBeforeFrom("")).toBeNull();
    expect(candleBeforeFrom(String(T0))?.valueOf()).toBe(T0);
    for (const bad of ["abc", "0", "-5", "2.5", "1e400", "9007199254740993"]) expect(candleBeforeFrom(bad)).toBe("invalid");
  });
});

describe("fetchCandleHistory paging", () => {
  it("Neon: the newest `limit` bars strictly before `before`, oldest first", async () => {
    if (!ready) return;
    const sym = `PG${randomUUID().slice(0, 6).toUpperCase()}`;
    await seedNeon(sym, 10);
    const { candles, source } = await fetchCandleHistory(sym, "M1", 3, new Date(T0 + 6 * 60_000));
    expect({ source, at: iso(candles) }).toEqual({
      source: "neon",
      at: [new Date(T0 + 3 * 60_000), new Date(T0 + 4 * 60_000), new Date(T0 + 5 * 60_000)].map((d) => d.toISOString()),
    });
    expect(iso((await fetchCandleHistory(sym, "M1", 3)).candles).at(-1)).toBe(new Date(T0 + 9 * 60_000).toISOString());
  });

  it("VPS: `before` and `limit` reach the engine's /internal/candles; an empty older page falls back to Neon with the same bound", async () => {
    if (!ready) return;
    const sym = `PV${randomUUID().slice(0, 6).toUpperCase()}`;
    await seedNeon(sym, 10);
    process.env.MARKET_DATA_URL = "https://feed.test.local";
    process.env.MARKET_DATA_READ_SECRET = "test-secret";
    process.env.MARKET_DATA_VPS_SYMBOLS = sym;
    const urls: string[] = [];
    let answer: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const engineRow = (ms: number) => ({ symbol: sym, timeframe: "M1", bucketStart: new Date(ms).toISOString(), open: "1", high: "2", low: "1", close: "1.5", updatedAt: new Date(ms).toISOString() });
    answer = [engineRow(T0 - 120_000), engineRow(T0 - 60_000)];
    const vps = await fetchCandleHistory(sym, "M1", 1200, new Date(T0));
    const q = new URL(urls[0]).searchParams;
    expect({ source: vps.source, n: vps.candles.length, limit: q.get("limit"), before: q.get("before"), tf: q.get("tf"), symbol: q.get("symbol") }).toEqual({
      source: "vps", n: 2, limit: "1200", before: String(T0), tf: "M1", symbol: sym,
    });
    // past the VPS retention the engine answers [] -> Neon, bounded the same way
    answer = [];
    const old = await fetchCandleHistory(sym, "M1", 2, new Date(T0 + 5 * 60_000));
    expect({ source: old.source, at: iso(old.candles) }).toEqual({ source: "neon-fallback", at: [new Date(T0 + 3 * 60_000).toISOString(), new Date(T0 + 4 * 60_000).toISOString()] });
    // no `before` = no param (the newest page, exactly as before web6)
    await fetchCandleHistory(sym, "M1", 300);
    expect(new URL(urls.at(-1)!).searchParams.has("before")).toBe(false);
  });
});

describe("GET /api/trade/candles with paging", () => {
  async function get(qs: string, session: { accountId: string; brokerId: string } | null) {
    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValue(session as never);
    const { GET } = await import("@/app/api/trade/candles/route");
    const res = await GET(new NextRequest(`https://t.local/api/trade/candles?${qs}`));
    return { status: res.status, json: await res.json() };
  }

  it("auth unchanged (401), a bad `before` is a 400, a good one pages back, limit honoured up to 1500", async () => {
    if (!ready) return;
    const sym = `PR${randomUUID().slice(0, 6).toUpperCase()}`;
    await seedNeon(sym, 1600);
    const s = { accountId: "acc", brokerId: "brk" };
    expect((await get(`symbol=${sym}&tf=M1&before=${T0}`, null)).status).toBe(401);
    expect((await get(`symbol=${sym}&tf=M1&before=yesterday`, s)).status).toBe(400);
    const page = await get(`symbol=${sym}&tf=M1&limit=2&before=${T0 + 100 * 60_000}`, s);
    expect({ status: page.status, at: iso(page.json) }).toEqual({ status: 200, at: [new Date(T0 + 98 * 60_000).toISOString(), new Date(T0 + 99 * 60_000).toISOString()] });
    expect((await get(`symbol=${sym}&tf=M1&limit=1500`, s)).json).toHaveLength(1500);
    expect((await get(`symbol=${sym}&tf=M1&limit=5000`, s)).json).toHaveLength(1500);
    expect((await get(`symbol=${sym}&tf=M1`, s)).json).toHaveLength(300);
  });
});
