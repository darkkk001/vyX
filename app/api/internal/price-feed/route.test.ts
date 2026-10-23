// Security re-audit 2026-10-23: the price feed takes its secret only in the Authorization header. The query form
// (?secret=...&data=...) is closed: 400, even with the right secret, and nothing is forwarded to the market data core.
// No secret / wrong secret on POST fails closed; the compare in lib/price-feed.ts is constant-time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/risk-monitor", () => ({ evaluateRiskForSymbol: vi.fn().mockResolvedValue(undefined) }));
const core = vi.fn(async () => Response.json({ ok: true, count: 1 }));
const KEYS = ["PRICE_FEED_SECRET", "TRADING_CORE_URL"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.PRICE_FEED_SECRET;
  process.env.TRADING_CORE_URL = "http://core.test";
  vi.stubGlobal("fetch", core);
});
afterEach(() => {
  for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const TICKS = [{ symbol: "XAUUSD", bid: 4000, ask: 4000.3 }];
const post = async (headers: Record<string, string>) => {
  const { POST } = await import("./route");
  return POST(new NextRequest("https://t.local/api/internal/price-feed", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(TICKS) }));
};

describe("price-feed: secret in the header only", () => {
  it("GET ?secret=<the right secret>&data=... -> 400 QUERY_SECRET_REFUSED, nothing forwarded", async () => {
    process.env.PRICE_FEED_SECRET = "feed-secret";
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("QUERY_SECRET_REFUSED");
    expect(core).not.toHaveBeenCalled();
  });
  it("the GET handler takes no request at all: it cannot read a query secret", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).toMatch(/export async function GET\(\)/);
    expect(src).not.toContain('searchParams.get("secret")');
  });
  it("POST with no session or secret: unset -> 503; set + missing / empty / wrong / same-length wrong -> 401; nothing forwarded", async () => {
    expect((await post({})).status).toBe(503);
    process.env.PRICE_FEED_SECRET = "feed-secret";
    for (const h of <Record<string, string>[]>[{}, { authorization: "Bearer " }, { authorization: "Bearer nope" }, { authorization: "Bearer feed-secreX" }, { authorization: "feed-secret" }]) {
      expect((await post(h)).status).toBe(401);
    }
    expect(core).not.toHaveBeenCalled();
  });
  it("POST with the right bearer secret forwards the ticks", async () => {
    process.env.PRICE_FEED_SECRET = "feed-secret";
    expect((await post({ authorization: "Bearer feed-secret" })).status).toBe(200);
    expect(core).toHaveBeenCalledTimes(1);
  });
  it("lib/price-feed.ts compares the secret in constant time", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "..", "lib", "price-feed.ts"), "utf8");
    expect(src).toContain("secretMatches(secret, configuredSecret)");
    expect(src).not.toMatch(/secret\s*!==\s*configuredSecret/);
  });
});
