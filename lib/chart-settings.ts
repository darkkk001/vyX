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
  // Previous day's high/low as labeled dashed lines (PDH/PDL), computed
  // client-side from the D1 candle series already loaded for every
  // symbol regardless of the active chart timeframe -- see
  // WebTrader.tsx's previousDayHighLow. Applies on every timeframe,
  // including D1 itself.
  showSessionHighLow: boolean;
  // Shaded Asia/London/New York session backgrounds (lib/session-map.ts)
  // -- intraday timeframes only (M1..H4); a daily+ bar already spans every
  // session, so the bands would be meaningless there.
  showSessionMap: boolean;
  showOhlcBar: boolean;
  // Only "UTC" is offered today -- groundwork for a real TZ selector, per
  // the chart interaction pack spec ("timezone display (UTC default --
  // groundwork for the TZ selector)").
  timezone: "UTC";
  // MT5-style terminal notification sounds (lib/sounds.ts) -- one master
  // switch plus a toggle per event so a trader can e.g. keep fills/SL/TP
  // audible but silence requotes. soundsEnabled gates all of them; a
  // false per-event toggle silences that event even if soundsEnabled is
  // true. soundError defaults off (a rejected order already gets a toast
  // -- the sound is opt-in noise, not a default alarm).
  soundsEnabled: boolean;
  soundOrderFilled: boolean;
  soundPositionClosed: boolean;
  soundSlHit: boolean;
  soundTpHit: boolean;
  soundPendingTriggered: boolean;
  soundRequoteReceived: boolean;
  soundAlertTriggered: boolean;
  soundError: boolean;
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
  showSessionHighLow: true,
  showSessionMap: true,
  showOhlcBar: true,
  timezone: "UTC",
  soundsEnabled: true,
  soundOrderFilled: true,
  soundPositionClosed: true,
  soundSlHit: true,
  soundTpHit: true,
  soundPendingTriggered: true,
  soundRequoteReceived: true,
  soundAlertTriggered: true,
  soundError: false,
};

// Merges a possibly-partial/stale persisted blob over the defaults so an
// old saved settings object (missing a field added after it was saved)
// never produces an undefined value the chart can't render.
export function mergeChartSettings(saved: unknown): ChartSettings {
  if (!saved || typeof saved !== "object") return DEFAULT_CHART_SETTINGS;
  return { ...DEFAULT_CHART_SETTINGS, ...(saved as Partial<ChartSettings>) };
}
