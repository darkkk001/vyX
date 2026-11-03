// Pure watchlist-column logic pulled out of components/webtrader/WebTrader.tsx
// so it's importable from a plain-node Vitest test (that file is JSX, which
// this project's vitest.config.mts deliberately doesn't parse -- see its own
// comment) -- same "extract the pure part into lib/*" convention as
// lib/chart-settings.ts's own DEFAULT_CHART_SETTINGS.

// The SIGNAL column (▲/▼ B/S-style badge next to price) was deliberately
// removed entirely in b21954c -- not toggled off, removed, because it was
// never a real trading signal, just the row's own bid-vs-dayOpen direction
// restated as an arrow, which read as investment advice from the platform.
// This type has no `signal` key, so it's a compile error for one to come
// back silently via a spread of some old saved layout object -- the test
// file alongside this one is the runtime trip-wire for the same fact.
export type WatchlistColumnPrefs = { ask: boolean; change: boolean; spread: boolean; high: boolean; low: boolean };

// Native-terminal alignment (owner 2026-11-03): the market watch shows SYMBOL / BID / ASK / SPREAD / CHG% like the
// desktop terminal; the daily high and low stay available from the column menu. Applies to every fresh session with
// no saved layout yet; a saved layout keeps its own choice, and a layout saved before ASK existed gets ASK on
// (withColumnDefaults).
export const DEFAULT_WATCHLIST_COLUMN_PREFS: WatchlistColumnPrefs = { ask: true, change: true, spread: true, high: false, low: false };

/** A saved layout's column choice with any column it predates filled from the defaults. */
export function withColumnDefaults(saved: Partial<WatchlistColumnPrefs> | null | undefined): WatchlistColumnPrefs {
  return { ...DEFAULT_WATCHLIST_COLUMN_PREFS, ...(saved ?? {}) };
}

// Watchlist SPREAD column -- MT4/5's own "points" convention: a symbol's
// point size is 10^-digits (its own smallest tradable price increment, the
// same value klinecharts' priceMark/tooltip formatting already keys off
// of), so a spread of 0.17 on a 2-digit symbol (XAUUSD) is 17 points, and
// 0.00002 on a 5-digit symbol (EURUSD) is 2 points -- a much more readable
// "how wide is this market" number than the raw price-unit difference, and
// the standard unit every MT4/5 trader already thinks in. Keeps one decimal
// for a genuinely fractional value (e.g. "0.2") rather than rounding it
// away -- only a whole-number result drops the trailing ".0".
export function spreadPoints(ask: number, bid: number, digits: number): string {
  const points = (ask - bid) * Math.pow(10, digits);
  return points.toFixed(1).replace(/\.0$/, "");
}
