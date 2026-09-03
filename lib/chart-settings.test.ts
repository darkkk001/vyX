import { describe, expect, it } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "./chart-settings";

describe("DEFAULT_CHART_SETTINGS", () => {
  // PDH/PDL (showSessionHighLow) was on for every trader with no saved
  // preference, cluttering every chart by default -- pinned off here so
  // it can't silently flip back on.
  it("defaults PDH/PDL (showSessionHighLow) to off", () => {
    expect(DEFAULT_CHART_SETTINGS.showSessionHighLow).toBe(false);
  });
});
