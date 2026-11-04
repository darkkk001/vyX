// Candle keys for calendar timeframes (owner 2026-11-05, candle de-dup fix 5). The engine buckets D1 / W1 / MN1 at the
// broker's midnight, NY-close: server time is UTC+3 while US summer time is in force, UTC+2 otherwise (engine
// market-data lib.rs bucket_start / offset_at_local; QoreBridge qb-feed offset.rs). The store holds older copies of the
// same day under other keys (21:00 / 22:00 / 00:00 UTC). This module maps any row to its ONE correct key so the reader
// can show a single bar per period, keeping the row that already sits on the correct key. Pure; no app-side prices.

const HOUR = 3_600_000;
const DAY = 86_400_000;

function daysFromCivil(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

/** The n-th Sunday of a month (UTC days since epoch). */
function nthSunday(y: number, m: number, n: number): number {
  const first = daysFromCivil(y, m, 1);
  const dow = new Date(first * DAY).getUTCDay(); // 0 = Sunday
  return first + ((7 - dow) % 7) + (n - 1) * 7;
}

/** US summer time at a UTC instant: second Sunday of March 07:00 UTC to first Sunday of November 06:00 UTC. */
export function usSummerTime(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear();
  const start = nthSunday(y, 3, 2) * DAY + 7 * HOUR;
  const end = nthSunday(y, 11, 1) * DAY + 6 * HOUR;
  return ms >= start && ms < end;
}

/** The NY-close broker offset in force at a UTC instant (ms). */
export function nyCloseOffsetMs(ms: number): number {
  return usSummerTime(ms) ? 3 * HOUR : 2 * HOUR;
}

/** The offset in force at a broker-local wall time (ms since epoch read as local), mirroring the engine's offset_at_local:
 *  judged just before the boundary at the winter offset. */
function offsetAtLocal(localMs: number): number {
  return nyCloseOffsetMs(localMs - 2 * HOUR);
}

export const CALENDAR_TIMEFRAMES = new Set(["D1", "W1", "MN1"]);

/**
 * The correct bucket start (UTC ms) for a stored calendar-timeframe row whose key may be off by the season or by a missing
 * offset. The probe (+2h) lands inside the right broker period for keys stored at offset 0, +2h or +3h.
 */
export function correctCalendarKey(timeframe: string, bucketStartMs: number): number {
  const probe = bucketStartMs + 2 * HOUR;
  const local = probe + nyCloseOffsetMs(probe);
  const d = new Date(local);
  let startLocal: number;
  if (timeframe === "D1") {
    startLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  } else if (timeframe === "W1") {
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    startLocal = day - d.getUTCDay() * DAY; // Sunday 00:00 server time
  } else if (timeframe === "MN1") {
    startLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  } else {
    return bucketStartMs;
  }
  return startLocal - offsetAtLocal(startLocal);
}

type Row = { bucketStart: Date; updatedAt: Date };

/**
 * One row per broker period for D1 / W1 / MN1, ordered oldest first. Prefers the row already on the correct key, else the
 * most recently updated one; the kept row is returned on the correct key. Other timeframes pass through unchanged.
 */
export function collapseCalendarRows<T extends Row>(timeframe: string, rows: T[]): T[] {
  if (!CALENDAR_TIMEFRAMES.has(timeframe)) return rows;
  const byKey = new Map<number, T>();
  for (const r of rows) {
    const key = correctCalendarKey(timeframe, r.bucketStart.getTime());
    const onKey = r.bucketStart.getTime() === key;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    const prevOnKey = prev.bucketStart.getTime() === key;
    if (onKey && !prevOnKey) byKey.set(key, r);
    else if (onKey === prevOnKey && r.updatedAt.getTime() > prev.updatedAt.getTime()) byKey.set(key, r);
  }
  return [...byKey.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, r]) => (r.bucketStart.getTime() === key ? r : { ...r, bucketStart: new Date(key) }));
}
