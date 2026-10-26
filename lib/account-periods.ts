import { nyCloseHourUtc } from "@/lib/market-week";
import { summarizeAccount, type AccountSummary } from "@/lib/account-summary";

// Realized P/L of the current trading day and week (owner 2026-10-26, terminal 1.0.96 + the backoffice client view):
// the deals CLOSED in the period with their own commission and swap, i.e. exactly the account summary's trades.netPnl
// over [start, now], so it can never disagree with the history summary bar or the statement. Floating P/L is never in
// it (that is OPEN P/L). The server states the boundaries; the apps only display them:
// - the trading day starts at the latest New York 17:00 (MT5 server midnight, the D1 candle anchor): 21:00 UTC in
//   summer, 22:00 in winter;
// - the trading week starts at the latest Sunday New York 17:00 (the FX week open).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** New York 17:00 on the UTC calendar day that starts at `utcMidnight` (DST read at that day's noon UTC). */
function nyCloseOn(utcMidnight: number): number {
  return utcMidnight + nyCloseHourUtc(new Date(utcMidnight + 12 * HOUR)) * HOUR;
}

export function tradingPeriodStarts(now: Date): { dayStart: Date; weekStart: Date } {
  const t = now.getTime();
  const midnight = Math.floor(t / DAY) * DAY;
  const today = nyCloseOn(midnight);
  const dayStart = today <= t ? today : nyCloseOn(midnight - DAY);
  let weekStart = NaN;
  for (let k = 0; k <= 7; k++) {
    const m = midnight - k * DAY;
    if (new Date(m).getUTCDay() !== 0) continue;
    const c = nyCloseOn(m);
    if (c <= t) {
      weekStart = c;
      break;
    }
  }
  return { dayStart: new Date(dayStart), weekStart: new Date(weekStart) };
}

export type RealizedBlock = { closes: number; grossPnl: string; commission: string; swap: string; netPnl: string };
export type RealizedPeriods = {
  asOf: string;
  boundary: "ny-close";
  dayStart: string;
  weekStart: string;
  dayRealizedPnl: string;
  weekRealizedPnl: string;
  day: RealizedBlock;
  week: RealizedBlock;
};

function block(s: AccountSummary): RealizedBlock {
  // closes = closed positions in the period (the summary's trades.count)
  return { closes: s.trades.count, grossPnl: s.trades.grossPnl, commission: s.trades.commission, swap: s.trades.swap, netPnl: s.trades.netPnl };
}

/** Throws SummaryNotFoundError (lib/account-summary) when the account is not in `scope`. */
export async function realizedPeriods(accountId: string, scope: { brokerId?: string } = {}, now = new Date()): Promise<RealizedPeriods> {
  const { dayStart, weekStart } = tradingPeriodStarts(now);
  const [day, week] = await Promise.all([
    summarizeAccount(accountId, { from: dayStart, to: now }, scope),
    summarizeAccount(accountId, { from: weekStart, to: now }, scope),
  ]);
  return {
    asOf: now.toISOString(),
    boundary: "ny-close",
    dayStart: dayStart.toISOString(),
    weekStart: weekStart.toISOString(),
    dayRealizedPnl: day.trades.netPnl,
    weekRealizedPnl: week.trades.netPnl,
    day: block(day),
    week: block(week),
  };
}
