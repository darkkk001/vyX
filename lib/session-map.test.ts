import { describe, it, expect } from "vitest";
import { computeSessionBands, isIntradayTimeframe } from "@/lib/session-map";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe("computeSessionBands", () => {
  it("returns empty for an invalid or empty range", () => {
    expect(computeSessionBands(NaN, 100)).toEqual([]);
    expect(computeSessionBands(100, 100)).toEqual([]);
    expect(computeSessionBands(200, 100)).toEqual([]);
  });

  it("emits three bands (asia/london/newyork) for one full UTC day", () => {
    const dayStart = 10 * DAY_MS; // arbitrary day boundary
    const bands = computeSessionBands(dayStart, dayStart + DAY_MS);
    expect(bands.map((b) => b.session)).toEqual(["asia", "london", "newyork"]);
    expect(bands[0]).toEqual({ session: "asia", startMs: dayStart, endMs: dayStart + 9 * HOUR_MS });
    expect(bands[1]).toEqual({ session: "london", startMs: dayStart + 8 * HOUR_MS, endMs: dayStart + 17 * HOUR_MS });
    expect(bands[2]).toEqual({ session: "newyork", startMs: dayStart + 13 * HOUR_MS, endMs: dayStart + 22 * HOUR_MS });
  });

  it("clips bands to the requested range instead of overrunning it", () => {
    const dayStart = 5 * DAY_MS;
    // Only ask for 00:00-05:00 -- should get a clipped Asia band and nothing else.
    const bands = computeSessionBands(dayStart, dayStart + 5 * HOUR_MS);
    expect(bands).toEqual([{ session: "asia", startMs: dayStart, endMs: dayStart + 5 * HOUR_MS }]);
  });

  it("spans multiple days when the range crosses a day boundary", () => {
    const dayStart = 3 * DAY_MS;
    const bands = computeSessionBands(dayStart + 21 * HOUR_MS, dayStart + DAY_MS + 2 * HOUR_MS);
    // Day 1: only New York's tail (21:00-22:00). Day 2: Asia's head (00:00-02:00).
    expect(bands).toEqual([
      { session: "newyork", startMs: dayStart + 21 * HOUR_MS, endMs: dayStart + 22 * HOUR_MS },
      { session: "asia", startMs: dayStart + DAY_MS, endMs: dayStart + DAY_MS + 2 * HOUR_MS },
    ]);
  });
});

describe("isIntradayTimeframe", () => {
  it("accepts intraday timeframes and rejects D1 and above", () => {
    expect(isIntradayTimeframe("M1")).toBe(true);
    expect(isIntradayTimeframe("H4")).toBe(true);
    expect(isIntradayTimeframe("D1")).toBe(false);
    expect(isIntradayTimeframe("W1")).toBe(false);
    expect(isIntradayTimeframe("MN1")).toBe(false);
    expect(isIntradayTimeframe("Y1")).toBe(false);
  });
});
