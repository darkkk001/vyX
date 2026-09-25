import "server-only";
import { fetchCandleHistory } from "@/lib/candles";

// The broker's trading day, the SAME boundary the charts' daily (D1) candles use (audit 2026-09-24 Batch 4, owner
// decision): the engine buckets D1 at the broker server's local midnight (engine/market-data/src/lib.rs
// broker_day_start), which moves with daylight saving -- 21:00 UTC in summer, 22:00 UTC in winter for a GMT+2/+3
// server. The web has no offset of its own, so it reads the start of the latest D1 candle from the same candle store
// the charts read (lib/candles.ts) and rolls it forward whole days if the new day's candle has not formed yet (no tick
// since the rollover). Fallback when no candle can be read: 22:00 UTC, and the caller is told so.

const DAY_MS = 86_400_000;
const REFERENCE_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD"];

export type TradingDay = { start: Date; source: "d1-candle" | "fallback-22utc" };

function bucketStartOf(c: unknown): Date | null {
  const raw = (c as { bucketStart?: unknown })?.bucketStart;
  const d = raw instanceof Date ? raw : typeof raw === "string" || typeof raw === "number" ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** Pure: the start of the day containing `now`, from a known day start (a D1 bucket). */
export function rollDayStart(knownStart: Date, now: Date): Date {
  const steps = Math.floor((now.getTime() - knownStart.getTime()) / DAY_MS);
  return new Date(knownStart.getTime() + Math.max(0, steps) * DAY_MS);
}

/** Pure: the fixed fallback, the latest 22:00 UTC at or before `now`. */
export function fallbackDayStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(22, 0, 0, 0);
  if (d > now) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

export async function tradingDayStart(now = new Date()): Promise<TradingDay> {
  for (const symbol of REFERENCE_SYMBOLS) {
    try {
      const { candles } = await fetchCandleHistory(symbol, "D1" as never, 2);
      const starts = candles.map(bucketStartOf).filter((d): d is Date => d !== null && d.getTime() <= now.getTime());
      if (starts.length === 0) continue;
      const latest = starts.reduce((a, b) => (b > a ? b : a));
      // a candle older than a week says nothing reliable about today's boundary (feed down for days)
      if (now.getTime() - latest.getTime() > 7 * DAY_MS) continue;
      return { start: rollDayStart(latest, now), source: "d1-candle" };
    } catch {
      // try the next reference symbol
    }
  }
  return { start: fallbackDayStart(now), source: "fallback-22utc" };
}
