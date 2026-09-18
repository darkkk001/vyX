import { describe, expect, it } from "vitest";
import { CANDLE_LIMIT_DEFAULT, candleLimitFrom } from "./candles";

// The candle routes honour `?limit=` only downwards: the terminal's rollover
// reconcile asks for a handful of rows, nothing may ask for more than the
// chart window.
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
  it("clamps anything larger to the window", () => {
    expect(candleLimitFrom("301")).toBe(CANDLE_LIMIT_DEFAULT);
    expect(candleLimitFrom("5000")).toBe(CANDLE_LIMIT_DEFAULT);
  });
});
