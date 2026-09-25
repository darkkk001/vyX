// The ONE weekly close / reopen rule (docs/contracts/fx-and-market-week.md §4, pinned by
// docs/contracts/market-week-vectors.json): markets that are not traded around the clock close Friday 17:00
// America/New_York and reopen Sunday 17:00 America/New_York -- 21:00 UTC while US daylight saving time is in force,
// 22:00 UTC otherwise. The engine (engine/market-data/src/gap_fill.rs market_closed) and the terminal (MarketSchedule)
// implement the same rule against the same vectors. Pure: used by the server's default session (lib/risk.ts) and by
// the web trader's candles (lib/market-simulator.ts). Crypto is exempt at the call sites; a broker's own
// TradingSession rows win over this default (lib/risk.ts checkTradingSession).

function nthSundayOfMonthUtc(year: number, month0: number, n: number): Date {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return new Date(Date.UTC(year, month0, firstSunday + (n - 1) * 7));
}

/** US Eastern daylight saving time: 2nd Sunday of March 02:00 EST (07:00 UTC) -> 1st Sunday of November 02:00 EDT (06:00 UTC). */
export function usEasternIsDst(now: Date): boolean {
  const y = now.getUTCFullYear();
  const start = nthSundayOfMonthUtc(y, 2, 2).getTime() + 7 * 3_600_000;
  const end = nthSundayOfMonthUtc(y, 10, 1).getTime() + 6 * 3_600_000;
  const t = now.getTime();
  return t >= start && t < end;
}

/** The UTC hour of 17:00 New York on this instant's date: 21 in summer (EDT), 22 in winter (EST). */
export function nyCloseHourUtc(now: Date): number {
  return usEasternIsDst(now) ? 21 : 22;
}

/** Friday 17:00 New York -> Sunday 17:00 New York. */
export function isWeeklyClosed(now: Date): boolean {
  const day = now.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const hour = now.getUTCHours();
  if (day === 6) return true;
  if (day === 5) return hour >= nyCloseHourUtc(now);
  if (day === 0) return hour < nyCloseHourUtc(now);
  return false;
}

/** The next Sunday 17:00 New York reopen strictly after `now` (as a UTC instant). */
export function nextWeeklyReopen(now: Date): Date {
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, 12));
    if (day.getUTCDay() !== 0) continue;
    const reopen = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), nyCloseHourUtc(day)));
    if (reopen.getTime() > now.getTime()) return reopen;
  }
  const d = new Date(now.getTime() + 7 * 86_400_000);
  return nextWeeklyReopen(d);
}
