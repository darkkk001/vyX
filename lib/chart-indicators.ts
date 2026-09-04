// Chart indicator catalog + persisted active-indicator state, mirroring
// lib/chart-settings.ts's own pattern exactly: a single JSON blob on
// Account.chartIndicators, server-side so it survives reload and syncs
// web/desktop, merged over defaults so an old/partial saved blob never
// produces an undefined value the chart can't render.
//
// Every entry here maps to a REAL klinecharts built-in indicator name
// (klinecharts.getSupportedIndicators() -- confirmed against the
// installed 9.8.12 bundle) EXCEPT "VWAP" and "ATR", which klinecharts
// does not ship. Those two are registered as real klinecharts indicators
// too (see KLineChartPanel.tsx's registerIndicator calls for VWAP/ATR),
// through the library's own official extension point -- calcParams,
// figures, precision, styles all work identically to a built-in from
// every call site in this file and KLineChartPanel.tsx. The only
// difference from a true built-in is that klinecharts didn't ship the
// calc formula, so this codebase supplies it; nothing here hand-rolls
// its own charting/rendering.
export type IndicatorKey =
  | "MA"
  | "EMA"
  | "BOLL"
  | "SAR"
  | "VWAP"
  | "RSI"
  | "MACD"
  | "KDJ"
  | "ATR"
  | "VOL"
  | "OBV"
  | "CCI"
  | "WR";

export type IndicatorPane = "overlay" | "subpane";

export type IndicatorDef = {
  key: IndicatorKey;
  // The real klinecharts indicator name passed to createIndicator/
  // overrideIndicator/removeIndicator -- identical to `key` for every
  // built-in; kept as its own field only so a future rename of `key`
  // (display concerns) can never accidentally change what's passed to
  // klinecharts itself.
  klineName: string;
  label: string;
  pane: IndicatorPane;
  // Real klinecharts default per the installed library's own source
  // (node_modules/klinecharts/dist/index.esm.js) for BOLL/SAR/MACD/KDJ/
  // VOL/OBV/CCI, since those five have a fixed-length calcParams their
  // calc() indexes into positionally -- passing a shorter/longer array
  // would silently misread a wrong parameter as another. MA/EMA/RSI/WR
  // (and the two custom ones, VWAP/ATR) instead default to a SINGLE
  // period, not klinecharts' own multi-line default (e.g. real MA ships
  // as calcParams:[5,10,30,60], 4 lines) -- verified safe by reading
  // each one's own regenerateFigures, which recomputes figures from
  // calcParams.length every time, so a 1-element array renders exactly
  // 1 line, not a partially-broken 4-line indicator. This matches how a
  // trader actually uses this: add the indicator once per period they
  // want (MA 20 and MA 50 as two separate, independently removable
  // instances), not one instance secretly drawing 4 lines at once.
  defaultCalcParams: number[];
  paramLabels: string[];
  // Decimal places for the indicator's own value display (tooltip/axis)
  // -- independent of the symbol's own price digits. 0 for
  // volume-shaped values (VOL/OBV), 2 for oscillators (RSI/KDJ/CCI/WR),
  // null for the four price-overlay indicators (MA/EMA/BOLL/SAR/VWAP),
  // which instead inherit the chart's live price precision (see
  // KLineChartPanel.tsx's indicator-creation effect).
  precision: number | null;
};

export const INDICATOR_DEFS: Record<IndicatorKey, IndicatorDef> = {
  MA: { key: "MA", klineName: "MA", label: "Moving Average", pane: "overlay", defaultCalcParams: [9], paramLabels: ["Period"], precision: null },
  EMA: { key: "EMA", klineName: "EMA", label: "EMA", pane: "overlay", defaultCalcParams: [9], paramLabels: ["Period"], precision: null },
  BOLL: { key: "BOLL", klineName: "BOLL", label: "Bollinger Bands", pane: "overlay", defaultCalcParams: [20, 2], paramLabels: ["Period", "StdDev"], precision: null },
  SAR: { key: "SAR", klineName: "SAR", label: "SAR", pane: "overlay", defaultCalcParams: [2, 2, 20], paramLabels: ["Start", "Increment", "Max"], precision: null },
  VWAP: { key: "VWAP", klineName: "VYX_VWAP", label: "VWAP", pane: "overlay", defaultCalcParams: [], paramLabels: [], precision: null },
  RSI: { key: "RSI", klineName: "RSI", label: "RSI", pane: "subpane", defaultCalcParams: [14], paramLabels: ["Period"], precision: 2 },
  MACD: { key: "MACD", klineName: "MACD", label: "MACD", pane: "subpane", defaultCalcParams: [12, 26, 9], paramLabels: ["Fast", "Slow", "Signal"], precision: null },
  KDJ: { key: "KDJ", klineName: "KDJ", label: "Stochastic (KDJ)", pane: "subpane", defaultCalcParams: [9, 3, 3], paramLabels: ["N", "K smoothing", "D smoothing"], precision: 2 },
  ATR: { key: "ATR", klineName: "VYX_ATR", label: "ATR", pane: "subpane", defaultCalcParams: [14], paramLabels: ["Period"], precision: null },
  VOL: { key: "VOL", klineName: "VOL", label: "Volume", pane: "subpane", defaultCalcParams: [5, 10, 20], paramLabels: ["MA1", "MA2", "MA3"], precision: 0 },
  OBV: { key: "OBV", klineName: "OBV", label: "OBV", pane: "subpane", defaultCalcParams: [30], paramLabels: ["MA Period"], precision: 0 },
  CCI: { key: "CCI", klineName: "CCI", label: "CCI", pane: "subpane", defaultCalcParams: [20], paramLabels: ["Period"], precision: 2 },
  WR: { key: "WR", klineName: "WR", label: "Williams %R", pane: "subpane", defaultCalcParams: [14], paramLabels: ["Period"], precision: 2 },
};

export const OVERLAY_INDICATOR_KEYS: IndicatorKey[] = ["MA", "EMA", "BOLL", "SAR", "VWAP"];
export const SUBPANE_INDICATOR_KEYS: IndicatorKey[] = ["RSI", "MACD", "KDJ", "ATR", "VOL", "OBV", "CCI", "WR"];

// One active instance of an indicator on the chart -- AT MOST ONE per
// `key` (klinecharts' own IndicatorStore.addInstance rejects a second
// instance of the same indicator NAME on the same pane with a real thrown
// "Duplicate indicators." error, confirmed by reading its source; this
// isn't a limitation this codebase invented). A trader who wants a
// second period of the same indicator (e.g. MA 20 AND MA 50 at once)
// gets that through `calcParams` holding multiple values, exactly how
// klinecharts' own built-in MA/EMA/RSI/WR already support multiple
// periods natively (each renders one line per calcParams entry via that
// indicator's own regenerateFigures) -- not through a second top-level
// entry here.
export type ActiveIndicator = {
  key: IndicatorKey;
  calcParams: number[];
};

export type ChartIndicatorsState = {
  active: ActiveIndicator[];
};

export const DEFAULT_CHART_INDICATORS: ChartIndicatorsState = { active: [] };

function isValidActiveIndicator(v: unknown): v is ActiveIndicator {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    o.key in INDICATOR_DEFS &&
    Array.isArray(o.calcParams) &&
    o.calcParams.length > 0 &&
    o.calcParams.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

// Same defensive shape as mergeChartSettings: a saved blob from a future
// version with fields this version doesn't know about, or a corrupted/
// partial one, must never crash the chart -- unknown/malformed entries
// are dropped rather than passed through to klinecharts' own
// createIndicator (which throws on garbage), and a duplicate `key`
// (shouldn't happen from this codebase's own save path, but a hand-edited
// or old blob might have one) keeps only the FIRST occurrence -- matches
// klinecharts' own one-instance-per-name-per-pane rule exactly.
export function mergeChartIndicators(saved: unknown): ChartIndicatorsState {
  if (!saved || typeof saved !== "object") return DEFAULT_CHART_INDICATORS;
  const active = (saved as { active?: unknown }).active;
  if (!Array.isArray(active)) return DEFAULT_CHART_INDICATORS;
  const seen = new Set<string>();
  const deduped: ActiveIndicator[] = [];
  for (const entry of active) {
    if (!isValidActiveIndicator(entry)) continue;
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    deduped.push(entry);
  }
  return { active: deduped };
}
