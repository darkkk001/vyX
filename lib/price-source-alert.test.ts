import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Owner 2026-10-05: a failed price read is retried once; staff are alerted only after ~20 s of continuous failure,
// once per outage, and told once when prices are back. Real Redis (scratch / Memurai); Prisma stubbed.
const createMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: { createMany: (...a: unknown[]) => createMany(...a) },
    broker: { findMany: async () => [{ id: "b1" }, { id: "b2" }] },
    livePrice: { findUnique: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { getLivePriceRowsWithSource } from "./live-price";
import { readVpsPrices } from "./market-data-client";
import { OUTAGE_ALERT_AFTER_MS, backText, outageDurationText, reportPriceSourceDown, reportPriceSourceOk, resetPriceSourceAlertThrottle, unavailableText } from "./price-source-alert";
import { getRedis } from "./redis";

const nowIso = () => new Date().toISOString();
const okList = () => new Response(JSON.stringify([{ symbol: "XAUUSD", bid: "4500.85", ask: "4501.05", tickAt: nowIso(), updatedAt: nowIso(), ageMs: 50 }]), { status: 200 });
const fail = { where: "test", reason: "timeout after 2000 ms" };
const types = () => createMany.mock.calls.map((c) => (c[0].data as { type: string }[])[0].type);

describe("price source alert", () => {
  const env = { ...process.env };
  beforeEach(async () => {
    process.env.MARKET_DATA_URL = "https://feed.example.test";
    process.env.MARKET_DATA_READ_SECRET = "read-secret";
    process.env.MARKET_DATA_PRICES = "vps";
    createMany.mockReset();
    resetPriceSourceAlertThrottle();
    await getRedis().del("price-source:first-fail", "price-source:last-ok", "price-source:outage", "price-source:last-outage");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("single blip: one failed read, then the retry succeeds -> prices returned, no alert", async () => {
    process.env.PRICE_READ_RETRY_DELAY_MS = "0";
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNRESET")).mockImplementation(async () => okList());
    const { rows, source } = await getLivePriceRowsWithSource(["XAUUSD"]);
    expect(source).toBe("vps");
    expect(rows.size).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("the stop-out trigger path pays at most ONE retry: 2 reads, about one retry delay, no loop", async () => {
    process.env.PRICE_READ_RETRY_DELAY_MS = "300";
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    const t0 = Date.now();
    const r = await readVpsPrices();
    const took = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(900);
  });

  it("2 failures within 20 s -> no alert", async () => {
    const t = 1_800_000_000_000;
    await reportPriceSourceDown(fail, t);
    await reportPriceSourceDown(fail, t + OUTAGE_ALERT_AFTER_MS - 1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("failures with a success in between never add up to an outage", async () => {
    const t = 1_800_000_000_000;
    await reportPriceSourceDown(fail, t);
    await reportPriceSourceOk(t + 5_000);
    await reportPriceSourceDown(fail, t + 15_000);
    await reportPriceSourceDown(fail, t + 30_000); // 30 s after the first failure, but only 15 s of continuous failure
    expect(createMany).not.toHaveBeenCalled();
  });

  it("continuous failure for 20 s+ -> exactly ONE 'unavailable' per broker, even from concurrent callers", async () => {
    const t = 1_800_000_000_000;
    await reportPriceSourceDown(fail, t);
    await reportPriceSourceDown(fail, t + 10_000);
    await Promise.all([reportPriceSourceDown(fail, t + 20_000), reportPriceSourceDown(fail, t + 20_001), reportPriceSourceDown(fail, t + 20_002)]);
    await reportPriceSourceDown(fail, t + 60_000);
    expect(createMany).toHaveBeenCalledTimes(1);
    const data = createMany.mock.calls[0][0].data as { brokerId: string; type: string; title: string; body: string }[];
    expect(data.map((d) => d.brokerId)).toEqual(["b1", "b2"]);
    expect(data[0]).toMatchObject({ type: "PRICE_SOURCE_DOWN", ...unavailableText(t) });
  });

  it("recovery -> exactly ONE 'back' with the right duration; the next outage alerts again", async () => {
    const t = 1_800_000_000_000;
    await reportPriceSourceDown(fail, t);
    await reportPriceSourceDown(fail, t + 25_000);
    await reportPriceSourceOk(t + 4 * 60_000 + 10_000);
    resetPriceSourceAlertThrottle();
    await reportPriceSourceOk(t + 4 * 60_000 + 20_000);
    expect(types()).toEqual(["PRICE_SOURCE_DOWN", "PRICE_SOURCE_BACK"]);
    const back = (createMany.mock.calls[1][0].data as { title: string; body: string }[])[0];
    expect(back).toEqual(expect.objectContaining(backText(t + 4 * 60_000 + 10_000, 4 * 60_000 + 10_000)));
    expect(back.body).toContain("(4 min)");
    // a new outage later is a new alert
    await reportPriceSourceDown(fail, t + 600_000);
    await reportPriceSourceDown(fail, t + 625_000);
    expect(types()).toEqual(["PRICE_SOURCE_DOWN", "PRICE_SOURCE_BACK", "PRICE_SOURCE_DOWN"]);
  });

  it("the staff wording never names our infrastructure", () => {
    const texts = [unavailableText(1_800_000_000_000), backText(1_800_000_060_000, 45_000), backText(1_800_000_060_000, 3 * 3600_000 + 5 * 60_000)];
    for (const { title, body } of texts) {
      for (const s of [title, body]) {
        expect(s).not.toMatch(/engine|timeout|http|mt5|caddy|feed|server|\d+\s*ms\b/i);
      }
    }
    expect(texts[1].body).toMatch(/\(<1 min\)\.$/);
    expect(outageDurationText(59_999)).toBe("<1 min");
    expect(outageDurationText(60_000)).toBe("1 min");
  });
});
