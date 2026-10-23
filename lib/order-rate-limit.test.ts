import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getRedis } from "@/lib/redis";
import { DEFAULT_ORDER_BURST, DEFAULT_ORDERS_PER_MINUTE, firstRefusalOfEpisode, limitsFrom, takeOrderToken } from "@/lib/order-rate-limit";
import { DEFAULT_ORDER_BURST_UI, DEFAULT_ORDERS_PER_MINUTE_UI } from "@/app/(super-admin)/(shell)/brokers/order-rate-defaults";

// The order token bucket (owner 2026-10-23) on the test Redis (db 9): burst, then a steady refill; nothing taken on a
// refusal; per account; fails open.

const acct = (n: string) => `rl-test-${n}`;
beforeEach(async () => {
  const r = getRedis();
  const keys = await r.keys("order-bucket*:rl-test-*");
  if (keys.length) await r.del(...keys);
});
afterAll(() => getRedis().disconnect());

describe("limitsFrom", () => {
  it("null = default, a broker value wins, 0 in either = off", () => {
    expect(limitsFrom(null)).toEqual({ burst: 100, perMinute: 600 });
    expect(limitsFrom({ orderBurst: 10, orderPerMinute: null })).toEqual({ burst: 10, perMinute: 600 });
    expect(limitsFrom({ orderBurst: 0, orderPerMinute: 600 })).toBeNull();
    expect(limitsFrom({ orderBurst: 100, orderPerMinute: 0 })).toBeNull();
  });
  it("the Super Admin form shows the same defaults", () => {
    expect([DEFAULT_ORDER_BURST_UI, DEFAULT_ORDERS_PER_MINUTE_UI]).toEqual([DEFAULT_ORDER_BURST, DEFAULT_ORDERS_PER_MINUTE]);
  });
});

describe("takeOrderToken", () => {
  const L = { burst: 100, perMinute: 600 };
  it("100 back to back pass, the 101st is refused with the wait until the next token", async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 100; i++) expect((await takeOrderToken(acct("a"), L, t0)).allowed).toBe(true);
    const r = await takeOrderToken(acct("a"), L, t0);
    expect(r).toEqual({ allowed: false, retryAfterMs: 100 }); // 600/min = one token every 100 ms
    expect((await takeOrderToken(acct("a"), L, t0 + 100)).allowed).toBe(true);
  });

  it("a steady 10 per second for 2 minutes is never refused, even after the burst is spent", async () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 100; i++) await takeOrderToken(acct("b"), L, t0);
    for (let i = 1; i <= 1200; i++) expect((await takeOrderToken(acct("b"), L, t0 + i * 100)).allowed, `order ${i}`).toBe(true);
  });

  it("a refused request takes no token: hammering while limited does not push the wait further out", async () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 100; i++) await takeOrderToken(acct("c"), L, t0);
    for (let i = 0; i < 50; i++) expect((await takeOrderToken(acct("c"), L, t0 + 50)).allowed).toBe(false);
    expect((await takeOrderToken(acct("c"), L, t0 + 100)).allowed).toBe(true);
  });

  it("one account at the cap does not limit another", async () => {
    const t0 = 4_000_000;
    for (let i = 0; i < 101; i++) await takeOrderToken(acct("d"), L, t0);
    expect((await takeOrderToken(acct("d"), L, t0)).allowed).toBe(false);
    expect((await takeOrderToken(acct("e"), L, t0)).allowed).toBe(true);
  });

  it("no cap (null) always passes; Redis down -> the order is allowed", async () => {
    expect((await takeOrderToken(acct("f"), null)).allowed).toBe(true);
    const r = getRedis();
    const spy = vi.spyOn(r, "eval").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await takeOrderToken(acct("g"), L)).allowed).toBe(true);
    spy.mockRestore();
    err.mockRestore();
  });

  it("one trace per throttled episode", async () => {
    expect(await firstRefusalOfEpisode(acct("h"), 100)).toBe(true);
    expect(await firstRefusalOfEpisode(acct("h"), 100)).toBe(false);
  });
});
