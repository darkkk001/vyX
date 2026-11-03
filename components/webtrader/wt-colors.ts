// The WebTrader's colour tokens as plain hex, for the places that cannot read a CSS variable: canvas drawing and the
// chart library's style options. The values are the ones in app/(broker)/trade/webtrader.css; wt-colors.test.ts checks
// the two stay the same.
//
// Platform colour rule (owner 2026-11-03, the same as the native terminal): BUY blue, SELL red, money never green.
//   buy / sell        the trade side (position and order lines, side tags)
//   profit / loss     money (P/L, take-profit and stop-loss levels)
//   ok                status only (LIVE, connected)
//   err               errors (a stop too close to the price)
//   tickUp / tickDown price direction (candles, ticks, sparkline), which stays green / red

export type WtMode = "dark" | "light";

export const WT_COLORS = {
  dark: { buy: "#4A7DD6", sell: "#C84A4A", profit: "#4A7DD6", loss: "#C84A4A", ok: "#16C784", err: "#E06464", tickUp: "#16C784", tickDown: "#EA3943" },
  light: { buy: "#2F6BD8", sell: "#C84A4A", profit: "#2F6BD8", loss: "#C84A4A", ok: "#0A7A4D", err: "#B3261E", tickUp: "#0A7A4D", tickDown: "#C8323C" },
} as const;

export type WtPalette = (typeof WT_COLORS)[WtMode];

/** The palette for the terminal's light / dark mode (ChartSettings.theme); anything else is dark. */
export function wtColors(mode: string | null | undefined): WtPalette {
  return mode === "light" ? WT_COLORS.light : WT_COLORS.dark;
}
