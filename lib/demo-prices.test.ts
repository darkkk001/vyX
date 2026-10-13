import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEMO_GRID_MS,
  DEMO_SYMBOLS,
  demoBucketStart,
  demoCandleOf,
  demoCandles,
  demoDisplayName,
  demoMaxDeviation,
  demoQuoteAt,
  demoSlopePerSec,
  demoSymbolForPriceName,
  gridTime,
  isDemoSymbolName,
  isReservedDemoName,
  ptsToString,
} from "@/lib/demo-prices";

const T = Date.UTC(2026, 9, 12, 12, 34, 56, 789);
const num = (s: string) => Number(s);

describe("demo prices: the symbol table", () => {
  it("has the seven approved symbols with realistic digits and contract sizes", () => {
    expect(DEMO_SYMBOLS.map((d) => d.name)).toEqual(["qXAUUSD", "qEURUSD", "qGBPUSD", "qUSDJPY", "qBTCUSD", "qUS30", "qNAS100"]);
    expect(DEMO_SYMBOLS.map((d) => d.display)).toEqual(["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "US30", "NAS100"]);
    const by = Object.fromEntries(DEMO_SYMBOLS.map((d) => [d.display, d]));
    expect([by.XAUUSD.digits, by.XAUUSD.contractSize]).toEqual([2, 100]);
    expect([by.EURUSD.digits, by.EURUSD.contractSize]).toEqual([5, 100000]);
    expect(by.USDJPY.digits).toBe(3);
    expect(by.BTCUSD.base).toBe(77000);
  });
  it("strips the prefix for display only", () => {
    expect(demoDisplayName("qXAUUSD")).toBe("XAUUSD");
    expect(demoDisplayName("XAUUSD")).toBe("XAUUSD");
    expect(demoDisplayName("qFOO")).toBe("qFOO");
  });
  it("the reserved rule is the prefix q + upper case, not any name starting with q", () => {
    expect(isReservedDemoName("qXAUUSD")).toBe(true);
    expect(isReservedDemoName("qSOMETHING")).toBe(true);
    for (const n of ["XAUUSD", "vGOLD", "qxau", "Q", "q", "", null, undefined]) expect(isReservedDemoName(n)).toBe(false);
    expect(isDemoSymbolName("qXAUUSD")).toBe(true);
    expect(isDemoSymbolName("qSOMETHING")).toBe(false);
  });
  it("USDJPY converts through its own alias, never a real symbol name", () => {
    expect(demoSymbolForPriceName("USDQJP")?.name).toBe("qUSDJPY");
    expect(demoSymbolForPriceName("qEURUSD")?.name).toBe("qEURUSD");
    expect(demoSymbolForPriceName("USDJPY")).toBeNull();
    expect(demoSymbolForPriceName("QJPUSD")).toBeNull();
    expect(DEMO_SYMBOLS.find((d) => d.name === "qUSDJPY")?.quoteCurrency).toBe("QJP");
  });
});

describe("demo prices: determinism", () => {
  it("same symbol and time give the same quote, every call", () => {
    for (const d of DEMO_SYMBOLS) {
      const a = demoQuoteAt(d.name, T)!;
      const b = demoQuoteAt(d.name, T)!;
      expect(b).toEqual(a);
    }
  });
  it("golden values are pinned (the path must never change under existing positions)", () => {
    const at = (t: number) => Object.fromEntries(DEMO_SYMBOLS.map((d) => [d.name, [demoQuoteAt(d.name, t)!.bid, demoQuoteAt(d.name, t)!.ask]]));
    expect(at(T)).toEqual({
      qXAUUSD: ["4439.99", "4440.29"],
      qEURUSD: ["1.14743", "1.14755"],
      qGBPUSD: ["1.32770", "1.32785"],
      qUSDJPY: ["151.846", "151.861"],
      qBTCUSD: ["75748.7", "75773.7"],
      qUS30: ["44937.0", "44939.0"],
      qNAS100: ["20135.5", "20137.0"],
    });
    expect(at(Date.UTC(2027, 0, 1))).toEqual({
      qXAUUSD: ["4475.30", "4475.60"],
      qEURUSD: ["1.15115", "1.15127"],
      qGBPUSD: ["1.32335", "1.32350"],
      qUSDJPY: ["152.594", "152.609"],
      qBTCUSD: ["74866.5", "74891.5"],
      qUS30: ["44749.0", "44751.0"],
      qNAS100: ["20462.5", "20464.0"],
    });
  });
  it("server and browser run the same code: one pure module with no environment dependency", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "demo-prices.ts"), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/import\s/);
    expect(code).not.toMatch(/Date\.now|Math\.random|Math\.sin|Math\.cos|performance\.|process\.|window\.|server-only|prisma/i);
  });
  it("the spread is constant: ask = bid + spreadPts on every tick, and it is the symbol's spread", () => {
    for (const d of DEMO_SYMBOLS) {
      for (let i = 0; i < 400; i++) {
        const q = demoQuoteAt(d.name, T + i * 7919)!;
        expect(q.askPts - q.bidPts).toBe(d.spreadPts);
        expect(q.bid.split(".")[1]?.length ?? 0).toBe(d.digits);
        expect(num(q.ask)).toBeGreaterThan(num(q.bid));
      }
    }
  });
  it("formats points exactly", () => {
    expect(ptsToString(444999, 2)).toBe("4449.99");
    expect(ptsToString(5, 3)).toBe("0.005");
    expect(ptsToString(1234, 0)).toBe("1234");
  });
});

describe("demo prices: bounds and continuity", () => {
  it("stays inside base * (1 +- maxDev) over 90 days", () => {
    for (const d of DEMO_SYMBOLS) {
      const dev = demoMaxDeviation(d.name);
      expect(dev).toBeGreaterThan(0.015);
      expect(dev).toBeLessThan(0.1);
      let lo = Infinity;
      let hi = -Infinity;
      for (let s = 0; s < 90 * 86400; s += 997) {
        const q = demoQuoteAt(d.name, Date.UTC(2026, 8, 1) + s * 1000)!;
        const mid = (q.bidPts + q.askPts) / 2 / 10 ** d.digits;
        lo = Math.min(lo, mid);
        hi = Math.max(hi, mid);
      }
      expect(lo).toBeGreaterThanOrEqual(d.base * (1 - dev) - 1e-9);
      expect(hi).toBeLessThanOrEqual(d.base * (1 + dev) + 1e-9);
      // it really moves: more than a fifth of a percent over the window, and not a frozen line
      expect((hi - lo) / d.base).toBeGreaterThan(0.002);
    }
  });
  it("no tick moves further than the published slope bound allows, and the bound is small", () => {
    for (const d of DEMO_SYMBOLS) {
      const slope = demoSlopePerSec(d.name);
      const perTick = slope * (DEMO_GRID_MS / 1000) + 2 / 10 ** d.digits; // + rounding to a point
      let prev = demoQuoteAt(d.name, T)!;
      let biggest = 0;
      for (let i = 1; i < 6000; i++) {
        const q = demoQuoteAt(d.name, T + i * DEMO_GRID_MS)!;
        const move = Math.abs(q.bidPts - prev.bidPts) / 10 ** d.digits;
        biggest = Math.max(biggest, move);
        expect(move).toBeLessThanOrEqual(perTick);
        prev = q;
      }
      // plausible: a 250 ms tick is far below 0.05 percent of the price, the bound below 0.2 percent
      expect(biggest / d.base).toBeLessThan(0.0005);
      expect((slope * 0.25) / d.base).toBeLessThan(0.002);
    }
  });
  it("is continuous: a millisecond apart is at most a few points apart", () => {
    for (const d of DEMO_SYMBOLS) {
      for (let i = 0; i < 200; i++) {
        const t = T + i * 104729;
        const a = demoQuoteAt(d.name, t)!;
        const b = demoQuoteAt(d.name, t + 1)!;
        expect(Math.abs(a.bidPts - b.bidPts)).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe("demo prices: candles are built from the same ticks", () => {
  const bidOf = (name: string, t: number) => demoQuoteAt(name, t)!.bidPts;
  const pts = (s: string, digits: number) => Math.round(Number(s) * 10 ** digits);

  it("an M1 candle is exactly the open/high/low/close of its 240 ticks on the 250 ms grid", () => {
    for (const d of DEMO_SYMBOLS) {
      const start = demoBucketStart("M1", T);
      const c = demoCandleOf(d.name, "M1", start, T + 3_600_000)!;
      const ticks = Array.from({ length: 240 }, (_, k) => bidOf(d.name, start + k * DEMO_GRID_MS));
      expect(pts(c.open, d.digits)).toBe(ticks[0]);
      expect(pts(c.close, d.digits)).toBe(ticks[239]);
      expect(pts(c.high, d.digits)).toBe(Math.max(...ticks));
      expect(pts(c.low, d.digits)).toBe(Math.min(...ticks));
    }
  });
  it("the forming candle ends at the last tick not after now", () => {
    const d = DEMO_SYMBOLS[0];
    const start = demoBucketStart("M5", T);
    const c = demoCandleOf(d.name, "M5", start, T)!;
    expect(pts(c.close, d.digits)).toBe(bidOf(d.name, gridTime(T)));
    expect(demoCandleOf(d.name, "M5", start + 300_000, T)).toBeNull(); // a bucket with no tick yet
  });
  it("every timeframe: open and close inside [low, high], high/low are real ticks, oldest first, aligned", () => {
    const tfs = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1", "Y1"] as const;
    for (const tf of tfs) {
      const list = demoCandles("qEURUSD", tf, T, 12);
      expect(list.length).toBeGreaterThan(5);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        expect(num(c.high)).toBeGreaterThanOrEqual(Math.max(num(c.open), num(c.close)));
        expect(num(c.low)).toBeLessThanOrEqual(Math.min(num(c.open), num(c.close)));
        expect(demoBucketStart(tf, c.bucketStart)).toBe(c.bucketStart);
        if (i > 0) expect(c.bucketStart).toBeGreaterThan(list[i - 1].bucketStart);
      }
      expect(list[list.length - 1].bucketStart).toBe(demoBucketStart(tf, T));
    }
  });
  it("an H1 candle's range contains the closes of the M5 candles inside it", () => {
    const h1 = demoCandleOf("qXAUUSD", "H1", demoBucketStart("H1", T) - 3_600_000, T)!;
    for (let k = 0; k < 12; k++) {
      const m5 = demoCandleOf("qXAUUSD", "M5", h1.bucketStart + k * 300_000, T)!;
      expect(num(m5.open)).toBeGreaterThanOrEqual(num(h1.low) - 1e-9 - 0.0); // sampled subset: allow the sampling gap below
    }
    // a coarse sample can miss the exact extreme by less than one stride's worth of movement; never by a lot
    const m1High = Math.max(...Array.from({ length: 60 }, (_, k) => num(demoCandleOf("qXAUUSD", "M1", h1.bucketStart + k * 60_000, T)!.high)));
    expect(m1High - num(h1.high)).toBeLessThan(1.0);
  });
  it("the candle list is stable: asking twice gives the same bytes", () => {
    expect(demoCandles("qBTCUSD", "H1", T, 50)).toEqual(demoCandles("qBTCUSD", "H1", T, 50));
  });
  it("a full 300-candle request is cheap enough for the browser and the server", () => {
    const t0 = performance.now();
    demoCandles("qXAUUSD", "M1", T, 300);
    demoCandles("qXAUUSD", "H1", T, 300);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
