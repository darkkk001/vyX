// lib/broker-resolve-cache.ts: the middleware's broker lookup cache (Neon load, 2026-10-05).
import { describe, expect, it } from "vitest";
import { BROKER_FRESH_MS, BROKER_STALE_MS, createBrokerResolver } from "@/lib/broker-resolve-cache";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("createBrokerResolver", () => {
  it("concurrent misses for one hostname make ONE lookup and all get its answer", async () => {
    const r = createBrokerResolver<string>();
    const d = deferred<string>();
    let calls = 0;
    const fetcher = () => (calls++, d.promise);
    const all = Promise.all(Array.from({ length: 9 }, () => r.resolve("futurixglobal.vyxtrader.com", fetcher)));
    d.resolve("broker-1");
    expect(await all).toEqual(Array(9).fill("broker-1"));
    expect(calls).toBe(1);
  });

  it("different hostnames do not share a lookup", async () => {
    const r = createBrokerResolver<string>();
    let calls = 0;
    const [a, b] = await Promise.all([r.resolve("a.x", async () => (calls++, "A")), r.resolve("b.x", async () => (calls++, "B"))]);
    expect([a, b, calls]).toEqual(["A", "B", 2]);
  });

  it("serves a fresh entry for 5 minutes without any lookup, then looks up again", async () => {
    const c = clock();
    const r = createBrokerResolver<string>({ now: c.now });
    let calls = 0;
    const fetcher = async () => `v${++calls}`;
    expect(await r.resolve("h", fetcher)).toBe("v1");
    c.advance(BROKER_FRESH_MS - 1);
    expect(await r.resolve("h", fetcher)).toBe("v1");
    expect(calls).toBe(1);
    c.advance(1);
    expect(await r.resolve("h", fetcher)).toBe("v2");
    expect(calls).toBe(2);
  });

  it("a failed lookup falls back to an entry up to 30 minutes old", async () => {
    const c = clock();
    const r = createBrokerResolver<string>({ now: c.now });
    await r.resolve("h", async () => "good");
    c.advance(BROKER_STALE_MS - 1);
    expect(await r.resolve("h", async () => { throw new Error("resolve-broker returned 500"); })).toBe("good");
    c.advance(1);
    await expect(r.resolve("h", async () => { throw new Error("resolve-broker returned 500"); })).rejects.toThrow("500");
  });

  it("every concurrent caller of a failed shared lookup gets the stale fallback", async () => {
    const c = clock();
    const r = createBrokerResolver<string>({ now: c.now });
    await r.resolve("h", async () => "good");
    c.advance(BROKER_FRESH_MS);
    const d = deferred<string>();
    let calls = 0;
    const all = Promise.all([1, 2, 3].map(() => r.resolve("h", () => (calls++, d.promise))));
    d.reject(new Error("timeout"));
    expect(await all).toEqual(["good", "good", "good"]);
    expect(calls).toBe(1);
  });

  it("a failure is never cached: with no entry it throws, and the next call looks up again", async () => {
    const r = createBrokerResolver<string>();
    let calls = 0;
    await expect(r.resolve("unknown.x", async () => { calls++; throw new Error("resolve-broker returned 404"); })).rejects.toThrow("404");
    expect(await r.resolve("unknown.x", async () => (calls++, "now-known"))).toBe("now-known");
    expect(calls).toBe(2);
  });

  it("a failed refresh keeps the last good entry (the failure does not replace it)", async () => {
    const c = clock();
    const r = createBrokerResolver<string>({ now: c.now });
    await r.resolve("h", async () => "good");
    c.advance(BROKER_FRESH_MS);
    expect(await r.resolve("h", async () => { throw new Error("blip"); })).toBe("good");
    // still stale-not-fresh: the next request retries the lookup (and succeeds)
    let calls = 0;
    expect(await r.resolve("h", async () => (calls++, "better"))).toBe("better");
    expect(calls).toBe(1);
  });
});
