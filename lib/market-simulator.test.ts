import { describe, expect, it } from "vitest";
import { createInitialMarket, tickMarket, bucketStartMs, resolveDayOpenFromD1, type Timeframe } from "@/lib/market-simulator";

// hotfix/terminal-live-bugs -- production showed XAUUSD's daily %chg as
// +88.85% (comparing a live ~4442 price against dayOpen, which was never
// anything but createInitialMarket()'s hardcoded launch-time seed,
// 2352.40, forever) and a chart whose last candle/dashed price line sat
// visibly behind the header's live bid. Both bugs live in this file's pure
// functions (tickMarket/applyBidAsk), not in React/klinecharts, so that's
// what these tests pin -- no DOM or component-test infra exists in this
// repo (see lib/risk.test.ts, lib/margin.test.ts for the same convention).

describe("tickMarket -- dayOpen (bug #1: impossible %chg)", () => {
  it("never reports dayOpen as the hardcoded seed price once a real tick has landed", () => {
    let market = createInitialMarket();
    const now = Date.UTC(2026, 7, 31, 8, 0, 0); // a D1 bucket boundary is irrelevant here -- any "now" starts a fresh D1 bucket the first time a symbol ever ticks
    market = tickMarket(market, { XAUUSD: { bid: 4442.58, ask: 4442.88, at: now } }, now);
    // The exact bug reported: def.base (2352.40) is XAUUSD's seed, wildly
    // different from any real current gold price -- dayOpen must have
    // moved off it the instant a live tick arrived.
    expect(market.XAUUSD.dayOpen).not.toBe(2352.40);
    expect(market.XAUUSD.dayOpen).toBe(4442.58);
  });

  it("resyncs dayOpen to the new bucket's open when a new UTC day starts, not just once at boot", () => {
    let market = createInitialMarket();
    const day1 = Date.UTC(2026, 7, 30, 23, 59, 0);
    market = tickMarket(market, { XAUUSD: { bid: 4400, ask: 4400.3, at: day1 } }, day1);
    expect(market.XAUUSD.dayOpen).toBe(4400);

    const day2 = Date.UTC(2026, 7, 31, 0, 0, 30); // crosses the D1 bucket boundary
    market = tickMarket(market, { XAUUSD: { bid: 4410, ask: 4410.3, at: day2 } }, day2);
    expect(market.XAUUSD.dayOpen).toBe(4410);
  });

  it("does not reset dayOpen on every tick within the same day, only on a genuine new D1 bucket", () => {
    let market = createInitialMarket();
    const t0 = Date.UTC(2026, 7, 31, 1, 0, 0);
    market = tickMarket(market, { XAUUSD: { bid: 4400, ask: 4400.3, at: t0 } }, t0);
    const t1 = t0 + 60_000;
    market = tickMarket(market, { XAUUSD: { bid: 4420, ask: 4420.3, at: t1 } }, t1);
    expect(market.XAUUSD.dayOpen).toBe(4400); // unchanged -- still the same D1 bucket
    expect(market.XAUUSD.bid).toBe(4420);

    // The resulting %chg is now a real, sane number instead of comparing
    // against a stale seed from a different order of magnitude.
    const changePct = ((market.XAUUSD.bid - market.XAUUSD.dayOpen) / market.XAUUSD.dayOpen) * 100;
    expect(changePct).toBeCloseTo(0.4545, 3);
  });

  it("marks dayOpen unknown at boot, and known only once a real tick's D1 rollover has synced it", () => {
    const market = createInitialMarket();
    expect(market.XAUUSD.dayOpenKnown).toBe(false);

    const now = Date.UTC(2026, 7, 31, 8, 0, 0);
    const ticked = tickMarket(market, { XAUUSD: { bid: 4442.58, ask: 4442.88, at: now } }, now);
    expect(ticked.XAUUSD.dayOpenKnown).toBe(true);
  });
});

describe("resolveDayOpenFromD1 (bug #1 follow-up: mid-day mount still showed the impossible %chg)", () => {
  // The rollover fix above only takes effect at the *next* UTC midnight --
  // a trader loading the terminal mid-day (the actual reported case, 07:52
  // UTC) needs dayOpen resolved from real D1 history immediately, or
  // shown as "—", never left on the launch-time seed.
  const now = Date.UTC(2026, 7, 31, 7, 52, 0);
  const todayBucket = bucketStartMs("D1", now);

  it("resolves today's open from the D1 row whose own bucket is the currently-open day", () => {
    const rows = [
      { bucketStart: new Date(todayBucket - 86_400_000).toISOString(), open: "4400.00" }, // yesterday
      { bucketStart: new Date(todayBucket).toISOString(), open: "4430.10" }, // today
    ];
    expect(resolveDayOpenFromD1(rows, now)).toBe(4430.10);
  });

  it("returns null (unknown, show \"—\") when no row matches today's bucket -- never falls back to a stale historical open", () => {
    const rows = [{ bucketStart: new Date(todayBucket - 86_400_000).toISOString(), open: "4400.00" }]; // only yesterday exists
    expect(resolveDayOpenFromD1(rows, now)).toBeNull();
  });

  it("returns null on an empty history response (brand-new symbol, or the history endpoint unreachable)", () => {
    expect(resolveDayOpenFromD1([], now)).toBeNull();
  });

  it("returns null rather than NaN on a malformed open value", () => {
    const rows = [{ bucketStart: new Date(todayBucket).toISOString(), open: "not-a-number" }];
    expect(resolveDayOpenFromD1(rows, now)).toBeNull();
  });
});

describe("tickMarket -- last-candle sync (bug #2: chart lagging the live tick)", () => {
  const TF: Timeframe = "M1";

  it("gives the current timeframe's last candle a fresh object reference on every real tick, with close matching the tick's bid", () => {
    let market = createInitialMarket();
    const t0 = Date.UTC(2026, 7, 31, 9, 0, 5); // inside the same M1 bucket as t1 below
    market = tickMarket(market, { XAUUSD: { bid: 4442.0, ask: 4442.3, at: t0 } }, t0);
    const barAfterFirstTick = market.XAUUSD.candles[TF][market.XAUUSD.candles[TF].length - 1];
    expect(barAfterFirstTick.c).toBe(4442.0);

    const t1 = t0 + 200; // same M1 bucket, a later tick 200ms on
    market = tickMarket(market, { XAUUSD: { bid: 4442.58, ask: 4442.88, at: t1 } }, t1);
    const barAfterSecondTick = market.XAUUSD.candles[TF][market.XAUUSD.candles[TF].length - 1];

    // This is the exact contract KLineChartPanel's `[latestBar]` effect
    // depends on to call klinecharts' updateData -- a same-reference bar
    // (or a close that silently didn't move) is indistinguishable from
    // "no new tick" to that effect, which is how the chart's last candle
    // and dashed last-price line went stale relative to the header bid.
    expect(barAfterSecondTick).not.toBe(barAfterFirstTick);
    expect(barAfterSecondTick.c).toBe(4442.58);
    expect(market.XAUUSD.bid).toBe(barAfterSecondTick.c);
  });

  it("keeps every consumer of bid (header, watchlist, chart candle) reading the identical value after a tick, never a stale one for any of them", () => {
    let market = createInitialMarket();
    const now = Date.UTC(2026, 7, 31, 9, 5, 0);
    market = tickMarket(market, { XAUUSD: { bid: 4439.0, ask: 4439.3, at: now } }, now);
    const laterSameBucket = now + 400;
    market = tickMarket(market, { XAUUSD: { bid: 4442.58, ask: 4442.88, at: laterSameBucket } }, laterSameBucket);

    const headerBid = market.XAUUSD.bid; // e.g. the chart-price / watchlist row value
    const lastCandleClose = market.XAUUSD.candles[TF][market.XAUUSD.candles[TF].length - 1].c; // dashed last-price line's source
    expect(lastCandleClose).toBe(headerBid);
    expect(lastCandleClose).toBe(4442.58);
  });

  it("bucket-aligns M1 candles identically to the server's own bucketing (bucketStartMs), so a live tick's bucket never disagrees with seeded history", () => {
    const now = Date.UTC(2026, 7, 31, 9, 5, 37);
    let market = createInitialMarket();
    market = tickMarket(market, { XAUUSD: { bid: 4442.58, ask: 4442.88, at: now } }, now);
    const bar = market.XAUUSD.candles[TF][market.XAUUSD.candles[TF].length - 1];
    expect(bar.t).toBe(bucketStartMs("M1", now));
    expect(bar.t % 60_000).toBe(0);
  });
});
