import { describe, expect, it } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "./chart-settings";

describe("DEFAULT_CHART_SETTINGS", () => {
  // Light is now the default -- a fresh login / an account that has never
  // saved a chart setting gets light; an explicit prior "dark" choice
  // (baked into that account's own saved Account.chartSettings blob)
  // always wins via mergeChartSettings' spread, unaffected by this default.
  it("defaults theme to light", () => {
    expect(DEFAULT_CHART_SETTINGS.theme).toBe("light");
  });

  // PDH/PDL (showSessionHighLow) was on for every trader with no saved
  // preference, cluttering every chart by default -- pinned off here so
  // it can't silently flip back on. See scripts/migrate-chart-defaults.ts
  // for the one-time backfill this needed for accounts that had already
  // saved a chart setting (and so already have the old `true` baked into
  // their own stored blob, which this default alone can't reach).
  it("defaults PDH/PDL (showSessionHighLow) to off", () => {
    expect(DEFAULT_CHART_SETTINGS.showSessionHighLow).toBe(false);
  });
});
