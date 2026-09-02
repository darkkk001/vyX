import { describe, expect, it } from "vitest";
import { createInitialMarket, tickMarket, bucketStartMs, resolveDayOpenFromD1, feedStatusFor, type Timeframe } from "@/lib/market-simulator";

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
    expect(resolveDayOpenFromD1(rows, now)).toEqual({ open: 4430.10, bucketStart: todayBucket });
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

describe("seedDayOpen contract -- does not get clobbered by the next live tick (production still showed +0.00% after the first fix)", () => {
  // Reproduces the exact production symptom step-by-step: a mocked D1
  // open (4430.10) that is deliberately far from the "current" tick's bid
  // (4439.48) -- if a caller patches only dayOpen/dayOpenKnown without
  // also writing lastCandleStart.D1 from resolveDayOpenFromD1's returned
  // bucketStart, this test fails the same way production did: the very
  // next tick's applyBidAsk treats lastCandleStart.D1's leftover 0 as "a
  // new D1 bucket just started" and stamps dayOpen back to that tick's own
  // bid, producing "+0.00%" (dayOpen === bid) instead of the real ~0.21%.
  it("keeps the resolved D1 open intact across the next live tick once lastCandleStart.D1 is synced from resolveDayOpenFromD1's bucketStart", () => {
    const now = Date.UTC(2026, 7, 31, 9, 24, 0);
    const todayBucket = bucketStartMs("D1", now);
    const rows = [{ bucketStart: new Date(todayBucket).toISOString(), open: "4430.10" }];
    const resolved = resolveDayOpenFromD1(rows, now);
    expect(resolved).not.toBeNull();

    let market = createInitialMarket();
    // What WebTrader.tsx's seedDayOpen does: patch dayOpen/dayOpenKnown
    // AND lastCandleStart.D1 in one update.
    market = {
      ...market,
      XAUUSD: {
        ...market.XAUUSD,
        dayOpen: resolved!.open,
        dayOpenKnown: true,
        lastCandleStart: { ...market.XAUUSD.lastCandleStart, D1: resolved!.bucketStart },
      },
    };

    // A live tick lands moments later, at a materially different price --
    // the mocked D1 open (4430.10) is deliberately far from this tick's
    // bid (4439.48), so any clobbering would be obvious.
    const tickAt = now + 500;
    market = tickMarket(market, { XAUUSD: { bid: 4439.48, ask: 4439.78, at: tickAt } }, tickAt);

    expect(market.XAUUSD.dayOpen).toBe(4430.10); // unchanged -- NOT the tick's bid
    expect(market.XAUUSD.bid).toBe(4439.48);
    const changePct = ((market.XAUUSD.bid - market.XAUUSD.dayOpen) / market.XAUUSD.dayOpen) * 100;
    expect(changePct).toBeCloseTo(0.2116, 3);
    expect(changePct).not.toBe(0);
  });

  it("regression: WITHOUT syncing lastCandleStart.D1, the next tick clobbers dayOpen to its own bid (the exact +0.00% production bug)", () => {
    // Same setup as above, but deliberately reproducing the broken
    // (round-1) behavior -- patching dayOpen/dayOpenKnown only, leaving
    // lastCandleStart.D1 at its createInitialMarket() default of 0 -- to
    // prove this test suite would have caught it.
    const now = Date.UTC(2026, 7, 31, 9, 24, 0);
    let market = createInitialMarket();
    market = { ...market, XAUUSD: { ...market.XAUUSD, dayOpen: 4430.10, dayOpenKnown: true } };

    const tickAt = now + 500;
    market = tickMarket(market, { XAUUSD: { bid: 4439.48, ask: 4439.78, at: tickAt } }, tickAt);

    // This is the bug: dayOpen got silently reset to the tick's own bid.
    expect(market.XAUUSD.dayOpen).toBe(4439.48);
    const changePct = ((market.XAUUSD.bid - market.XAUUSD.dayOpen) / market.XAUUSD.dayOpen) * 100;
    expect(changePct).toBe(0);
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

  // round-2 hotfix -- production report was specifically "H1, last candle
  // not tracking ticks" (header 4439.48 vs bar close 4435). applyBidAsk's
  // TIMEFRAMES.forEach applies the identical logic to every timeframe --
  // this is the same contract as the M1 tests above, parameterized over
  // every fixed-duration timeframe this app charts, so a future change
  // that special-cases one timeframe and silently breaks another gets
  // caught here instead of in production again.
  it.each(["M1", "M5", "M30", "H1", "H4", "D1"] as const)(
    "keeps %s's last bar in sync with the live tick (same reference-change + close-match contract as M1)",
    (tf) => {
      let market = createInitialMarket();
      const t0 = Date.UTC(2026, 7, 31, 9, 0, 0);
      market = tickMarket(market, { XAUUSD: { bid: 4435.0, ask: 4435.3, at: t0 } }, t0);
      const firstBar = market.XAUUSD.candles[tf][market.XAUUSD.candles[tf].length - 1];

      const t1 = t0 + 1000; // well within every one of these bucket sizes
      market = tickMarket(market, { XAUUSD: { bid: 4439.48, ask: 4439.78, at: t1 } }, t1);
      const secondBar = market.XAUUSD.candles[tf][market.XAUUSD.candles[tf].length - 1];

      expect(secondBar).not.toBe(firstBar);
      expect(secondBar.c).toBe(4439.48);
      expect(secondBar.c).toBe(market.XAUUSD.bid); // never a gap between header bid and this bar's close
    }
  );
});

describe("tickMarket -- local gap-fill (round 5: patchy M1, missing bars mid-session)", () => {
  const TF: Timeframe = "M1";

  it("does not gap-fill the very first tick this symbol has ever seen (lastCandleStart is still the 0 sentinel)", () => {
    const market = createInitialMarket();
    const now = Date.UTC(2026, 7, 31, 12, 0, 0); // Monday
    const ticked = tickMarket(market, { XAUUSD: { bid: 4400, ask: 4400.3, at: now } }, now);
    expect(ticked.XAUUSD.candles[TF]).toHaveLength(1); // just the one real bar, no fabricated history before it
  });

  it("flat-fills every skipped minute between the last known bucket and the new tick's bucket", () => {
    let market = createInitialMarket();
    const t0 = Date.UTC(2026, 7, 31, 12, 0, 0); // Monday
    market = tickMarket(market, { XAUUSD: { bid: 4400, ask: 4400.3, at: t0 } }, t0);

    // Simulates the exact seam this fix targets: a history fetch (or a
    // throttled tab) leaves lastCandleStart[tf] several minutes behind the
    // next real tick's own bucket.
    const t4 = t0 + 4 * 60_000; // 4 minutes later -- 3 minutes skipped
    market = tickMarket(market, { XAUUSD: { bid: 4410, ask: 4410.3, at: t4 } }, t4);

    const bars = market.XAUUSD.candles[TF];
    expect(bars).toHaveLength(5); // t0's real bar + 3 flat-filled + t4's real bar
    expect(bars.map((b) => b.t)).toEqual([t0, t0 + 60_000, t0 + 120_000, t0 + 180_000, t4]);
    // Every flat-filled bar carries the last known close forward flat --
    // same shape as engine/market-data/src/gap_fill.rs's own fills.
    for (const bar of bars.slice(1, 4)) {
      expect(bar.o).toBe(4400);
      expect(bar.h).toBe(4400);
      expect(bar.l).toBe(4400);
      expect(bar.c).toBe(4400);
    }
    expect(bars[4].c).toBe(4410); // the real tick's own bar, untouched
  });

  it("never fabricates a bar during a real weekend close for a non-continuously-traded symbol", () => {
    let market = createInitialMarket();
    // Friday 20:58 UTC -> Monday 00:02 UTC, well past the FX/metals
    // weekend close on both ends.
    const fri = Date.UTC(2026, 7, 28, 20, 58, 0);
    market = tickMarket(market, { XAUUSD: { bid: 4400, ask: 4400.3, at: fri } }, fri);
    const mon = Date.UTC(2026, 7, 31, 0, 2, 0);
    market = tickMarket(market, { XAUUSD: { bid: 4410, ask: 4410.3, at: mon } }, mon);

    const bars = market.XAUUSD.candles[TF];
    // Only Fri 20:58, Fri 20:59, Fri 21:00 (still <21:00 isn't reached --
    // 20:58 -> 20:59 is the only fillable minute before the 21:00 close)
    // and the real Monday bar should exist; nothing across the weekend.
    for (const bar of bars) {
      const d = new Date(bar.t);
      const day = d.getUTCDay();
      const hour = d.getUTCHours();
      const isWeekendClosed = day === 6 || (day === 5 && hour >= 21) || (day === 0 && hour < 22);
      expect(isWeekendClosed).toBe(false);
    }
  });

  it("does fabricate bars across the weekend for a continuously-traded (CRYPTO) symbol", () => {
    let market = createInitialMarket();
    const fri = Date.UTC(2026, 7, 28, 23, 58, 0);
    market = tickMarket(market, { BTCUSD: { bid: 60000, ask: 60010, at: fri } }, fri);
    const sat = Date.UTC(2026, 7, 29, 0, 2, 0); // 4 minutes later, deep into Saturday
    market = tickMarket(market, { BTCUSD: { bid: 60100, ask: 60110, at: sat } }, sat);

    const bars = market.BTCUSD.candles[TF];
    const saturdayBars = bars.filter((b) => new Date(b.t).getUTCDay() === 6);
    expect(saturdayBars.length).toBeGreaterThan(0); // crypto keeps ticking through the weekend, so gap-fill must too
  });

  it("caps the number of local gap-fill bars for a pathological gap instead of fabricating thousands", () => {
    let market = createInitialMarket();
    const t0 = Date.UTC(2026, 7, 31, 0, 0, 0); // Monday midnight
    market = tickMarket(market, { XAUUSD: { bid: 4400, ask: 4400.3, at: t0 } }, t0);
    const farFuture = t0 + 10 * 86_400_000; // 10 days later (a tab asleep for over a week)
    market = tickMarket(market, { XAUUSD: { bid: 4410, ask: 4410.3, at: farFuture } }, farFuture);

    // Bounded, not the ~9,360 minutes that would otherwise separate these
    // two ticks (10 days of M1 buckets).
    expect(market.XAUUSD.candles[TF].length).toBeLessThan(200);
  });

  it("still respects the 300-bar cap after a multi-bar local gap-fill push", () => {
    let market = createInitialMarket();
    const t0 = Date.UTC(2026, 7, 31, 0, 0, 0);
    market = tickMarket(market, { XAUUSD: { bid: 4400, ask: 4400.3, at: t0 } }, t0);
    const later = t0 + 250 * 60_000; // 250 skipped minutes, well within the local gap-fill cap
    market = tickMarket(market, { XAUUSD: { bid: 4410, ask: 4410.3, at: later } }, later);
    expect(market.XAUUSD.candles[TF].length).toBeLessThanOrEqual(300);
  });
});

// hotfix/terminal-live-bugs #4 -- a fresh login flashed "No live feed" for
// about a second before settling into the real state. Root cause: `now`
// is serverNow() (lib/desktop-api.ts), clock-corrected only once an API
// response's Date header has been seen -- a WS tick carries no such
// header, so the very first tick of a session judged against an
// uncalibrated client clock can compute an artificially huge (or
// negative) age purely from ordinary clock drift, unrelated to whether
// the feed is actually connected.
describe("feedStatusFor (hotfix/terminal-live-bugs #4: no premature no-feed flash)", () => {
  const sessionStart = 1_000_000;

  it("still returns connecting with no ticks yet, within the 30s window", () => {
    expect(feedStatusFor(0, sessionStart + 100, sessionStart)).toBe("connecting");
    expect(feedStatusFor(0, sessionStart + 29_999, sessionStart)).toBe("connecting");
  });

  it("returns no-feed once the no-ticks-yet session exceeds 30s", () => {
    expect(feedStatusFor(0, sessionStart + 30_001, sessionStart)).toBe("no-feed");
  });

  it("returns live for a fresh tick, stale for an aging one, once the session is old enough", () => {
    const now = sessionStart + 10_000;
    expect(feedStatusFor(now - 1000, now, sessionStart)).toBe("live");
    expect(feedStatusFor(now - 10_000, now, sessionStart)).toBe("stale");
  });

  it("the exact reported bug: an apparently-ancient tick age within the first 5s of the session reads as connecting, not no-feed", () => {
    // A tick timestamped "now" from the server's clock, but the client's
    // own now() is still far off (uncalibrated) -- exactly what an
    // unrecalibrated serverTimeOffsetMs produces on the very first tick.
    const now = sessionStart + 500; // 500ms into the session
    const clockSkewedLastTickAt = now - 45_000; // looks 45s stale from an uncalibrated clock
    expect(feedStatusFor(clockSkewedLastTickAt, now, sessionStart)).toBe("connecting");
  });

  it("a genuinely dead feed still reports no-feed once the session itself is old enough", () => {
    const now = sessionStart + 6000; // past the 5s grace window
    const longDeadTickAt = now - 45_000;
    expect(feedStatusFor(longDeadTickAt, now, sessionStart)).toBe("no-feed");
  });
});
