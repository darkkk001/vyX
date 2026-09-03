import { describe, expect, it } from "vitest";
import { DEFAULT_WATCHLIST_COLUMN_PREFS, spreadPoints, type WatchlistColumnPrefs } from "./watchlist-columns";

describe("DEFAULT_WATCHLIST_COLUMN_PREFS", () => {
  it("is exactly Symbol/Price (always on) + Spread/Day H/Day L, no Chg%", () => {
    expect(DEFAULT_WATCHLIST_COLUMN_PREFS).toEqual({ change: false, spread: true, high: true, low: true });
  });

  // The SIGNAL column (▲/▼ badge) was deliberately removed in b21954c --
  // WatchlistColumnPrefs has no `signal` key at all, so this is really a
  // compile-time guarantee; this assertion is the runtime trip-wire for
  // the same fact, in case a future edit widens the type back out.
  it("has no signal key", () => {
    expect("signal" in (DEFAULT_WATCHLIST_COLUMN_PREFS as WatchlistColumnPrefs)).toBe(false);
  });
});

describe("spreadPoints", () => {
  it("shows a whole number of points with no trailing .0", () => {
    expect(spreadPoints(4396.38, 4396.24, 2)).toBe("14"); // XAUUSD-shaped: 0.14 * 10^2
  });

  it("keeps one decimal for a fractional point value instead of rounding it away", () => {
    expect(spreadPoints(1.158922, 1.158920, 5)).toBe("0.2"); // EURUSD-shaped: 0.000002 * 10^5
  });

  it("shows a genuine zero-spread tick as 0, not a fabricated value", () => {
    expect(spreadPoints(1.15892, 1.15892, 5)).toBe("0");
  });
});
