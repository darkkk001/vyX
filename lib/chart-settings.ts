// Chart appearance/behavior prefs, persisted server-side on
// Account.chartSettings (a single JSON blob -- see that field's schema
// comment). Shared between the website and the bundled desktop shells,
// same as lib/watchlist.ts's watchlist rows.
export type ChartSettings = {
  candleUpColor: string;
  candleDownColor: string;
  candleUpBorderColor: string;
  candleDownBorderColor: string;
  candleUpWickColor: string;
  candleDownWickColor: string;
  showGrid: boolean;
  showLastPriceLine: boolean;
  showSessionHighLow: boolean;
  showOhlcBar: boolean;
  // Only "UTC" is offered today -- groundwork for a real TZ selector, per
  // the chart interaction pack spec ("timezone display (UTC default --
  // groundwork for the TZ selector)").
  timezone: "UTC";
};

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  candleUpColor: "#26a69a",
  candleDownColor: "#ef5350",
  candleUpBorderColor: "#26a69a",
  candleDownBorderColor: "#ef5350",
  candleUpWickColor: "#26a69a",
  candleDownWickColor: "#ef5350",
  showGrid: true,
  showLastPriceLine: true,
  showSessionHighLow: false,
  showOhlcBar: true,
  timezone: "UTC",
};

// Merges a possibly-partial/stale persisted blob over the defaults so an
// old saved settings object (missing a field added after it was saved)
// never produces an undefined value the chart can't render.
export function mergeChartSettings(saved: unknown): ChartSettings {
  if (!saved || typeof saved !== "object") return DEFAULT_CHART_SETTINGS;
  return { ...DEFAULT_CHART_SETTINGS, ...(saved as Partial<ChartSettings>) };
}
