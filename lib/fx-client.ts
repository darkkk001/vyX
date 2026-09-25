// Client-side quote -> account conversion for the web trader (FX batch 2026-09-26, docs/contracts/fx-and-market-week.md).
// Plain numbers, no server imports: the SAME rule as lib/fx.ts conversionRate (mid of the pair, else 1 / mid of the
// inverse, else a cross through USD; a quote 72 h old or older counts as none) and the same money formulas as the
// server. lib/fx-contract.test.ts pins these functions to docs/contracts/fx-vectors.json, like the terminal's.

export const FX_RATE_MAX_AGE_MS = 72 * 3_600_000;

export type FxQuoteNum = { bid: number; ask: number; tickAtMs: number };
export type FxLookupNum = (symbol: string) => { bid: number; ask: number } | undefined;

/** The quotes the server sent (fx.quotes), overlaid by live ticks of the same symbols -- the newer tick wins -- with
 *  the 72 h age limit applied at `nowMs`. */
export function fxLookupNum(quotes: Record<string, FxQuoteNum>, nowMs: number, live?: Record<string, FxQuoteNum | undefined>): FxLookupNum {
  const cutoff = nowMs - FX_RATE_MAX_AGE_MS;
  return (symbol) => {
    const a = quotes[symbol];
    const b = live?.[symbol];
    const q = a && b ? (b.tickAtMs >= a.tickAtMs ? b : a) : a ?? b;
    return q && q.tickAtMs > cutoff ? { bid: q.bid, ask: q.ask } : undefined;
  };
}

function mid(q: { bid: number; ask: number } | undefined): number | null {
  if (!q) return null;
  const m = (q.bid + q.ask) / 2;
  return Number.isFinite(m) && m > 0 ? m : null;
}
function direct(from: string, to: string, lookup: FxLookupNum): number | null {
  const d = mid(lookup(from + to));
  if (d) return d;
  const inv = mid(lookup(to + from));
  return inv ? 1 / inv : null;
}

/** Multiply an amount in `from` by this to get `to`. null = no price to convert with (the position is unpriced). */
export function conversionRateNum(from: string, to: string, lookup: FxLookupNum): number | null {
  const f = from.trim().toUpperCase();
  const t = to.trim().toUpperCase();
  if (f === t) return 1;
  const d = direct(f, t, lookup);
  if (d) return d;
  if (f !== "USD" && t !== "USD") {
    const a = direct(f, "USD", lookup);
    const b = direct("USD", t, lookup);
    if (a && b) return a * b;
  }
  return null;
}

/** A symbol's quote currency: the server's field, else the last three letters of a six-letter FX-style name. */
export function quoteCurrencyOf(def: { name: string; quoteCurrency?: string }): string | null {
  if (def.quoteCurrency) return def.quoteCurrency.toUpperCase();
  return /^[A-Z]{6}$/.test(def.name) ? def.name.slice(3) : null;
}

// ---- money, account currency (each null when the rate is null) ----
export function pnlInAccount(side: "BUY" | "SELL", openPrice: number, bid: number, ask: number, contractSize: number, volume: number, rate: number | null): number | null {
  if (rate == null) return null;
  const close = side === "BUY" ? bid : ask;
  return (side === "BUY" ? close - openPrice : openPrice - close) * contractSize * volume * rate;
}
export function marginInAccount(side: "BUY" | "SELL", bid: number, ask: number, contractSize: number, volume: number, leverage: number, rate: number | null): number | null {
  if (rate == null) return null;
  const price = side === "BUY" ? bid : ask;
  return ((volume * contractSize * price) / leverage) * rate;
}
export function newOrderMarginInAccount(volume: number, contractSize: number, fillPrice: number, leverage: number, rate: number | null): number | null {
  return rate == null ? null : ((volume * contractSize * fillPrice) / leverage) * rate;
}
export function pointValueInAccount(volume: number, contractSize: number, digits: number, rate: number | null): number | null {
  return rate == null ? null : volume * contractSize * Math.pow(10, -digits) * rate;
}
