// The range chips of the backoffice cards (bo 1.0.96, owner 2026-10-27: Dashboard and Deposits cards follow the range
// dropdown). One definition so every card of every screen means the same window:
//   ?range=TODAY | 3D | 5D | 7D | 30D | 90D | 1Y (aliases 1D, 1M) -> whole broker trading days ending with today's (lib/trading-day.ts):
//                                               TODAY = from today's day start; nD = from the start of the day n-1 days
//                                               before today's (so 7D = today + the 6 trading days before it)
//   ?from=&to=  (ISO, the app's CUSTOM)       -> [from, to); no to = up to now
//   neither                                   -> the caller's default key
// `to` is null for "up to now". The resolved window is echoed back so the app labels what the server applied.

const DAY_MS = 86_400_000;

export const RANGE_KEYS = ["TODAY", "3D", "5D", "7D", "30D", "90D", "1Y"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number] | "CUSTOM";
export type DashRange = { key: RangeKey; from: Date; to: Date | null };

const DAYS: Record<(typeof RANGE_KEYS)[number], number> = { TODAY: 1, "3D": 3, "5D": 5, "7D": 7, "30D": 30, "90D": 90, "1Y": 365 };
// the Dealing card's chips (bo 1.0.96): 1D = TODAY, 1M = 30D
const ALIASES: Record<string, (typeof RANGE_KEYS)[number]> = { "1D": "TODAY", "1M": "30D" };

/** Pure: the window of a range key, given the start of today's trading day. */
export function rangeFromKey(key: (typeof RANGE_KEYS)[number], dayStart: Date): DashRange {
  return { key, from: new Date(dayStart.getTime() - (DAYS[key] - 1) * DAY_MS), to: null };
}

/** Pure: ?range or ?from/?to into a window; an error is one line for a 400. */
export function parseDashRange(sp: URLSearchParams, dayStart: Date, fallback: (typeof RANGE_KEYS)[number]): DashRange | { error: string } {
  const rawFrom = sp.get("from");
  const rawTo = sp.get("to");
  if (rawFrom || rawTo) {
    if (!rawFrom) return { error: "from is required with to" };
    const from = new Date(rawFrom);
    const to = rawTo ? new Date(rawTo) : null;
    if (Number.isNaN(from.getTime()) || (to && Number.isNaN(to.getTime()))) return { error: "from and to must be dates, for example 2026-10-01 or 2026-10-01T21:00:00Z" };
    if (to && to <= from) return { error: "to must be later than from" };
    return { key: "CUSTOM", from, to };
  }
  const given = sp.get("range")?.trim().toUpperCase();
  if (!given) return rangeFromKey(fallback, dayStart);
  const raw = ALIASES[given] ?? given;
  if (!(RANGE_KEYS as readonly string[]).includes(raw)) return { error: `range must be one of ${RANGE_KEYS.join(", ")}` };
  return rangeFromKey(raw as (typeof RANGE_KEYS)[number], dayStart);
}

export function rangeJson(r: DashRange) {
  return { key: r.key, from: r.from.toISOString(), to: r.to ? r.to.toISOString() : null };
}
