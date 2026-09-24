import { describe, expect, it } from "vitest";
import { DEFAULT_CHART_SETTINGS, mergeChartSettings } from "./chart-settings";

describe("DEFAULT_CHART_SETTINGS", () => {
  // Light is now the default -- a fresh login / an account that has never
  // saved a chart setting gets light; an explicit prior "dark" choice
  // (baked into that account's own saved Account.chartSettings blob)
  // always wins via mergeChartSettings' spread, unaffected by this default.
  it("defaults theme to light", () => {
    expect(DEFAULT_CHART_SETTINGS.theme).toBe("light");
  });

  // 2026-09-24: a new account's chart starts clean (no session map, no PDH/PDL); mergeChartSettings keeps any
  // account's explicitly saved value.
  it("a new account's chart starts clean: no session map, no session high/low", () => {
    expect(DEFAULT_CHART_SETTINGS.showSessionMap).toBe(false);
    expect(DEFAULT_CHART_SETTINGS.showSessionHighLow).toBe(false);
    expect(mergeChartSettings({ showSessionMap: true }).showSessionMap).toBe(true);
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

  it("defaults one-click trading to off", () => {
    expect(DEFAULT_CHART_SETTINGS.oneClickDefault).toBe(false);
  });

  // Collapsible panel system -- everything starts open for a fresh login
  // / an account that has never saved a chart setting.
  it("defaults every collapsible-panel flag to open (false)", () => {
    expect(DEFAULT_CHART_SETTINGS.watchlistCollapsed).toBe(false);
    expect(DEFAULT_CHART_SETTINGS.orderTicketPanelCollapsed).toBe(false);
    expect(DEFAULT_CHART_SETTINGS.bottomPanelCollapsed).toBe(false);
    expect(DEFAULT_CHART_SETTINGS.orderTicketSectionCollapsed).toBe(false);
    expect(DEFAULT_CHART_SETTINGS.tradingSessionsSectionCollapsed).toBe(false);
    expect(DEFAULT_CHART_SETTINGS.economicCalendarSectionCollapsed).toBe(false);
  });
});
