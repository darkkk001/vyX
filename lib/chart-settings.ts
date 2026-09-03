// Chart appearance/behavior prefs, persisted server-side on
// Account.chartSettings (a single JSON blob -- see that field's schema
// comment). Shared between the website and the bundled desktop shells,
// same as lib/watchlist.ts's watchlist rows.
export type ChartSettings = {
  // Light/dark terminal theme -- see app/(broker)/trade/webtrader.css's
  // .wt-root[data-mode="light"] block (WebTrader.tsx sets data-mode from
  // this field) and KLineChartPanel.tsx's CHART_COLORS map, which mirrors
  // the same two palettes for the canvas-rendered chart (grid/axis/
  // tooltip -- CSS custom properties can't reach into klinecharts' own
  // draw calls, so those few values are kept in sync by hand between the
  // two files). Buy/sell/accent colors are deliberately IDENTICAL in both
  // themes -- only backgrounds/borders/text/grid-lines change. Defaults
  // to "light" (DEFAULT_CHART_SETTINGS below) -- a fresh login or any
  // account that has never saved a chart setting at all gets light; the
  // sun/moon toggle and an explicit prior "dark" choice always win, same
  // "saved blob overrides the default" rule every other field here follows.
  theme: "dark" | "light";
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
  // Terminal notification sounds (lib/sounds.ts) -- one master
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
  // Menu IA pass -- the order ticket's "One-click trading" toggle used to
  // be a plain useState(false) in WebTrader.tsx, resetting every reload.
  // The new Settings > Trading tab calls this a "default," which only
  // means something if it actually persists -- moved here, server-side,
  // same as everything else on this page. The order ticket's own checkbox
  // and the Quick Actions menu's toggle both still work exactly as
  // before, they just read/write this field now instead of local state.
  oneClickDefault: boolean;
  // Collapsible panel system -- server-persisted (per account, synced
  // web/desktop) so a trader's layout choice follows them, unlike
  // orderPanelWidth/watchlistWidth/bottomPanelHeight (WebTrader.tsx's own
  // StoredLayout), which stay a per-browser localStorage preference.
  // Defaults false (everything open) for every field here -- a fresh
  // login or an account that has never saved a chart setting gets the
  // full layout, same "saved blob overrides the default" rule every
  // other field follows.
  watchlistCollapsed: boolean;
  orderTicketPanelCollapsed: boolean;
  bottomPanelCollapsed: boolean;
  orderTicketSectionCollapsed: boolean;
  tradingSessionsSectionCollapsed: boolean;
  economicCalendarSectionCollapsed: boolean;
};

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  // Light is the default now -- a fresh login with no saved preference
  // gets light; the sun/moon toggle and an explicit prior choice still
  // win (see mergeChartSettings below -- a saved blob with theme:"dark"
  // in it always overrides this). scripts/migrate-chart-defaults.ts is
  // the one-time backfill for accounts that saved a blob BEFORE this
  // default flipped (their blob has no `theme` key at all, since the
  // field didn't exist yet then, and this default alone already covers
  // exactly that case correctly via mergeChartSettings' spread) --
  // that script exists for showSessionHighLow below, not this field.
  theme: "light",
  candleUpColor: "#26a69a",
  candleDownColor: "#ef5350",
  candleUpBorderColor: "#26a69a",
  candleDownBorderColor: "#ef5350",
  candleUpWickColor: "#26a69a",
  candleDownWickColor: "#ef5350",
  showGrid: true,
  showLastPriceLine: true,
  // Defaults OFF -- was on for every trader with no saved preference,
  // cluttering every chart by default. Unlike `theme` above, this one
  // NEEDS the one-time migration (scripts/migrate-chart-defaults.ts):
  // ChartSettingsDialog.tsx always PUTs the FULL settings object (see
  // the API route's own comment), so any account that has EVER saved
  // ANY chart setting already has `showSessionHighLow: true` baked into
  // its stored blob explicitly -- mergeChartSettings' spread can't tell
  // "explicitly baked in because it was the old default" apart from
  // "explicitly chosen" from the stored JSON alone, so this default
  // flip alone only reaches accounts that have NEVER saved any chart
  // setting at all.
  showSessionHighLow: false,
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
  oneClickDefault: false,
  watchlistCollapsed: false,
  orderTicketPanelCollapsed: false,
  bottomPanelCollapsed: false,
  orderTicketSectionCollapsed: false,
  tradingSessionsSectionCollapsed: false,
  economicCalendarSectionCollapsed: false,
};

// Merges a possibly-partial/stale persisted blob over the defaults so an
// old saved settings object (missing a field added after it was saved)
// never produces an undefined value the chart can't render.
export function mergeChartSettings(saved: unknown): ChartSettings {
  if (!saved || typeof saved !== "object") return DEFAULT_CHART_SETTINGS;
  return { ...DEFAULT_CHART_SETTINGS, ...(saved as Partial<ChartSettings>) };
}
