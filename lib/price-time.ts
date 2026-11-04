import "server-only";
import { fetchCandleHistory } from "@/lib/candles";

// Manual position: open time from the open price (staff order brief point 8, owner 2026-10-29). The SERVER owns the lookup; the backoffice only shows
// and edits it. The most recent moment the symbol's price range contained `price` (low <= price <= high), never in the future and never before the
// account opened. There is no tick store (owner decision 2026-10-29: minute-level ships; seconds are a future item on the trigger-tick capture), so
// the answer is a candle bucket's start and its precision. The candles hold ONE price series (the bid, as the chart), returned as `series`.
//
// Coarse to fine, so a lookup is a handful of reads instead of a minute-by-minute scan of 30 days: the newest H1 bar whose range holds the price,
// then that hour's M1 bars (M5 when the minutes are past retention), else the hour itself; older history from D1.

export type PriceTimeAnswer =
  | { at: string; precision: "minute" | "5 minutes" | "hour" | "day"; timeframe: "M1" | "M5" | "H1" | "D1"; series: "bid" }
  | { at: null; reason: "NOT_FOUND" };

type Bar = { bucketStart: Date; low: number; high: number };
/** Newest-first pages of a symbol's bars: `before` = an exclusive upper bound on bucketStart; [] = no more. */
export type BarFetch = (symbol: string, timeframe: "M1" | "M5" | "H1" | "D1", limit: number, before: Date | null) => Promise<Bar[]>;

export const fetchBars: BarFetch = async (symbol, timeframe, limit, before) => {
  const { candles } = await fetchCandleHistory(symbol, timeframe, limit, before);
  return (candles as { bucketStart: string | Date; low: unknown; high: unknown }[])
    .map((c) => ({ bucketStart: new Date(c.bucketStart), low: Number(c.low), high: Number(c.high) }))
    .filter((b) => Number.isFinite(b.low) && Number.isFinite(b.high))
    .sort((a, b) => b.bucketStart.getTime() - a.bucketStart.getTime());
};

const MS = { M1: 60_000, M5: 300_000, H1: 3_600_000, D1: 86_400_000 } as const;
const PAGE = 300;
const MAX_PAGES = 8; // H1: 100 days, D1: 6.5 years -- beyond that the price is "not found"

const holds = (b: Bar, price: number) => b.low <= price && price <= b.high;

/** The newest bar of `timeframe` holding the price, not before `notBefore`, searching back from `before` (null = now). */
async function newestHolding(fetch: BarFetch, symbol: string, timeframe: "M1" | "M5" | "H1" | "D1", price: number, notBefore: Date, before: Date | null, pages: number): Promise<Bar | null> {
  let cursor = before;
  for (let i = 0; i < pages; i++) {
    const bars = await fetch(symbol, timeframe, PAGE, cursor);
    if (bars.length === 0) return null;
    for (const b of bars) {
      if (b.bucketStart.getTime() + MS[timeframe] <= notBefore.getTime()) return null; // the whole bar is before the account opened
      if (holds(b, price)) return b;
    }
    cursor = bars[bars.length - 1].bucketStart;
  }
  return null;
}

export async function lookupPriceTime(symbol: string, price: number, accountOpenedAt: Date, now: Date = new Date(), fetch: BarFetch = fetchBars): Promise<PriceTimeAnswer> {
  if (!Number.isFinite(price) || price <= 0) return { at: null, reason: "NOT_FOUND" };
  const answer = (b: Bar, timeframe: "M1" | "M5" | "H1" | "D1"): PriceTimeAnswer => {
    // never before the account opened (a bar that started earlier but holds the moment it opened answers that moment) and never in the future
    const at = new Date(Math.min(Math.max(b.bucketStart.getTime(), accountOpenedAt.getTime()), now.getTime()));
    const precision = timeframe === "M1" ? "minute" : timeframe === "M5" ? "5 minutes" : timeframe === "H1" ? "hour" : "day";
    return { at: at.toISOString(), precision, timeframe, series: "bid" };
  };

  const hour = await newestHolding(fetch, symbol, "H1", price, accountOpenedAt, null, MAX_PAGES);
  if (hour) {
    const hourEnd = new Date(hour.bucketStart.getTime() + MS.H1);
    for (const tf of ["M1", "M5"] as const) {
      const bars = (await fetch(symbol, tf, Math.ceil(MS.H1 / MS[tf]), hourEnd)).filter((b) => b.bucketStart >= hour.bucketStart);
      const fine = bars.find((b) => holds(b, price) && b.bucketStart.getTime() + MS[tf] > accountOpenedAt.getTime());
      if (fine) return answer(fine, tf);
      if (bars.length > 0) break; // the minutes exist but none holds the price exactly (a gap in the series): the hour is the answer
    }
    return answer(hour, "H1");
  }
  const day = await newestHolding(fetch, symbol, "D1", price, accountOpenedAt, null, MAX_PAGES);
  return day ? answer(day, "D1") : { at: null, reason: "NOT_FOUND" };
}
