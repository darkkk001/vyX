import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getLivePriceRows } from "@/lib/live-price";

// Quote-currency -> account-currency conversion (2026-09-23).
//
// A position's P&L comes out of computeRealizedPnl in the symbol's QUOTE currency ((close - open) x
// contractSize x volume: USDJPY in JPY, EURGBP in GBP, GER40 in EUR), and requiredMarginFor's
// volume x contractSize x price is a quote-currency notional too. Until this module both were added
// straight to the account's balance / margin as if they were already in the account's currency, which is
// only true when the two match (every XXXUSD symbol on a USD account). On USDJPY a 1-lot, 10-pip win booked
// 1,000 (JPY) as 1,000 USD, and its margin read ~150x too high. Every money figure now goes through
// conversionRate(quote, account) first; for the common case (same currency) that is exactly 1 and no price
// is read at all.
//
// Rate: the MID of the conversion pair's latest quote, as MT5 does for a cross when it has to pick one side
// for a figure that is not itself a fill. Tick-level freshness is NOT required: an FX rate a few minutes old
// moves a P&L by a fraction of a percent, while no conversion at all is wrong by the whole exchange rate.
// But an age LIMIT is (2026-09-25): a quote older than FX_RATE_MAX_AGE_MS counts as no price at all, so the
// caller refuses (FxRateUnavailableError / the position is unpriced) instead of converting with it. Before, a
// VPS outage fell back to Neon's LivePrice, which stopped moving when the feed's writes went VPS-local (S5):
// every non-USD conversion would silently have used a 10-day-old rate. 72 h still covers a normal weekend or
// holiday (Friday's FX close to the Sunday reopen is ~49 h: a BTC position in a EUR account is valued on
// Saturday with Friday's EURUSD, as MT5 does). The engine applies the same limit (order-management book.rs).

export type FxQuote = { bid: Prisma.Decimal; ask: Prisma.Decimal };
export type FxLookup = (symbol: string) => FxQuote | undefined;

const ONE = new Prisma.Decimal(1);

/** A conversion quote older than this is not used (see the header). Keep equal to the engine's FX_RATE_MAX_AGE. */
export const FX_RATE_MAX_AGE_MS = 72 * 3600 * 1000;

export class FxRateUnavailableError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`no ${from}->${to} conversion rate: none of ${conversionSymbolsFor(from, to).join(", ")} has a price`);
  }
}

function mid(q: FxQuote | undefined): Prisma.Decimal | null {
  if (!q) return null;
  const m = q.bid.add(q.ask).div(2);
  return m.gt(0) ? m : null;
}

// One leg: from -> to through the pair itself or its inverse.
function direct(from: string, to: string, lookup: FxLookup): Prisma.Decimal | null {
  const d = mid(lookup(from + to));
  if (d) return d;
  const inv = mid(lookup(to + from));
  return inv ? ONE.div(inv) : null;
}

/** Multiply an amount in `from` by this to get `to`. null = no price to convert with. */
export function conversionRate(from: string, to: string, lookup: FxLookup): Prisma.Decimal | null {
  const f = from.trim().toUpperCase();
  const t = to.trim().toUpperCase();
  if (f === t) return ONE;
  const d = direct(f, t, lookup);
  if (d) return d;
  // cross through USD (JPY -> EUR = JPY -> USD -> EUR): every broker quotes the majors against USD
  if (f !== "USD" && t !== "USD") {
    const a = direct(f, "USD", lookup);
    const b = direct("USD", t, lookup);
    if (a && b) return a.mul(b);
  }
  return null;
}

/** Every symbol conversionRate may read for from -> to (none when they match). */
export function conversionSymbolsFor(from: string, to: string): string[] {
  const f = from.trim().toUpperCase();
  const t = to.trim().toUpperCase();
  if (f === t) return [];
  const out = [f + t, t + f];
  if (f !== "USD" && t !== "USD") out.push(f + "USD", "USD" + f, t + "USD", "USD" + t);
  return out;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Loads (in one read) the latest quotes every listed conversion may need. Pairs whose two currencies
 *  match need nothing, so the everyday all-USD case costs no query at all. */
export async function loadFxLookup(db: Db, pairs: Iterable<readonly [string, string]>): Promise<FxLookup> {
  const symbols = new Set<string>();
  for (const [from, to] of pairs) for (const s of conversionSymbolsFor(from, to)) symbols.add(s);
  if (symbols.size === 0) return () => undefined;
  const rows = await getLivePriceRows([...symbols], db);
  return fxLookupFromQuotes(rows.values(), Date.now());
}

/** The lookup over a set of quotes, with the age limit applied: a quote whose tick is FX_RATE_MAX_AGE_MS old or
 *  older is no price at all (refuse, never a stale rate). The one place that rule lives -- loadFxLookup and the FX
 *  contract vectors (lib/fx-contract.ts) both go through it. */
export function fxLookupFromQuotes(
  quotes: Iterable<{ symbol: string; bid: Prisma.Decimal | string | number; ask: Prisma.Decimal | string | number; tickAt: Date }>,
  nowMs: number
): FxLookup {
  const cutoff = nowMs - FX_RATE_MAX_AGE_MS;
  const bySymbol = new Map<string, FxQuote>();
  for (const q of quotes) {
    if (q.tickAt.getTime() > cutoff) bySymbol.set(q.symbol, { bid: new Prisma.Decimal(q.bid), ask: new Prisma.Decimal(q.ask) });
  }
  return (symbol) => bySymbol.get(symbol);
}

/** Rates for several (quote, account) pairs from ONE quote read: `rate(quote, account)` is conversionRate's answer,
 *  null = unpriced. `quotes` are the rows it read (already within the 72 h limit), for a client that re-prices live. */
export async function loadRateResolver(db: Db, pairs: Iterable<readonly [string, string]>): Promise<{
  rate: (quoteCurrency: string, accountCurrency: string) => Prisma.Decimal | null;
  quotes: { symbol: string; bid: string; ask: string; tickAt: string }[];
}> {
  const list = [...pairs];
  const symbols = new Set<string>();
  for (const [from, to] of list) for (const s of conversionSymbolsFor(from, to)) symbols.add(s);
  const rows = symbols.size > 0 ? await getLivePriceRows([...symbols], db) : new Map();
  const now = Date.now();
  const lookup = fxLookupFromQuotes(rows.values(), now);
  const fresh = [...rows.values()].filter((r) => r.tickAt.getTime() > now - FX_RATE_MAX_AGE_MS);
  return {
    rate: (quoteCurrency, accountCurrency) => conversionRate(quoteCurrency, accountCurrency, lookup),
    quotes: fresh.map((r) => ({ symbol: r.symbol, bid: r.bid.toString(), ask: r.ask.toString(), tickAt: r.tickAt.toISOString() })),
  };
}

/** The rate for one pair, loaded now. Throws FxRateUnavailableError when there is nothing to convert with. */
export async function quoteToAccountRate(db: Db, quoteCurrency: string, accountCurrency: string): Promise<Prisma.Decimal> {
  const lookup = await loadFxLookup(db, [[quoteCurrency, accountCurrency]]);
  const rate = conversionRate(quoteCurrency, accountCurrency, lookup);
  if (!rate) throw new FxRateUnavailableError(quoteCurrency.toUpperCase(), accountCurrency.toUpperCase());
  return rate;
}
