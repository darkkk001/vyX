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
export type WatchlistColumnPrefs = { change: boolean; spread: boolean; high: boolean; low: boolean };

// Spread + the daily H/L range are the columns an MT4/5 trader actually
// scans a watchlist for; %Chg is available but not on by default. Applies
// to every fresh session with no saved layout yet (see WebTrader.tsx's
// `storedLayout.columnPrefs ??` fallback) -- an existing saved layout is a
// real per-trader choice and is never overwritten by this.
export const DEFAULT_WATCHLIST_COLUMN_PREFS: WatchlistColumnPrefs = { change: false, spread: true, high: true, low: true };

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
