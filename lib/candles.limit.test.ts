import { describe, expect, it } from "vitest";
import { CANDLE_LIMIT_DEFAULT, CANDLE_LIMIT_MAX, candleLimitFrom } from "./candles";

// The candle routes honour `?limit=`: the terminal's rollover reconcile asks
// for a handful of rows; a chart paging back (web6, issue 17) may ask for up
// to CANDLE_LIMIT_MAX; absent or unusable = the default window.
describe("candleLimitFrom", () => {
  it("serves the full window when the param is absent or unusable", () => {
    for (const raw of [null, "", "abc", "0", "-5", "2.5", "NaN"]) {
      expect(candleLimitFrom(raw)).toBe(CANDLE_LIMIT_DEFAULT);
    }
  });
  it("honours a smaller integer limit", () => {
    expect(candleLimitFrom("3")).toBe(3);
    expect(candleLimitFrom("1")).toBe(1);
    expect(candleLimitFrom("299")).toBe(299);
  });
  it("honours a larger limit up to the paging cap, and clamps beyond it", () => {
    expect(CANDLE_LIMIT_MAX).toBe(1500);
    expect(candleLimitFrom("301")).toBe(301);
    expect(candleLimitFrom("1500")).toBe(1500);
    expect(candleLimitFrom("1501")).toBe(CANDLE_LIMIT_MAX);
    expect(candleLimitFrom("5000")).toBe(CANDLE_LIMIT_MAX);
  });
});
