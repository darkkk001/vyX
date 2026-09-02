// Chart session map (Impression Pack #2) -- shaded Asia/London/New York
// background bands for intraday timeframes. Same UTC session-hour
// convention as components/webtrader/SessionClock.tsx (Sydney folded
// into "Asia" here since the user-facing spec only asks for three named
// bands, not four) -- approximate, no regional DST adjustment, matching
// every other "glance value" session indicator in this app.
export type SessionName = "asia" | "london" | "newyork";

export type SessionBand = {
  session: SessionName;
  // Epoch ms, already clipped to [fromMs, toMs].
  startMs: number;
  endMs: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// [startHourUtc, endHourUtc) -- Asia (Tokyo hours) wraps midnight-to-9am,
// so it's expressed as an offset from each UTC day's own start rather
// than needing wraparound handling like SessionClock's isActive().
const SESSION_HOURS: { session: SessionName; startHour: number; endHour: number }[] = [
  { session: "asia", startHour: 0, endHour: 9 },
  { session: "london", startHour: 8, endHour: 17 },
  { session: "newyork", startHour: 13, endHour: 22 },
];

// Enumerates every session band whose time range overlaps [fromMs, toMs),
// one entry per UTC calendar day covered, clipped to the requested range.
// Pure/deterministic -- no Date.now(), so it's trivially testable and safe
// to recompute on every candle-data change without any caching concern.
export function computeSessionBands(fromMs: number, toMs: number): SessionBand[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

  const bands: SessionBand[] = [];
  const firstDayStart = Math.floor(fromMs / DAY_MS) * DAY_MS;

  for (let dayStart = firstDayStart; dayStart < toMs; dayStart += DAY_MS) {
    for (const { session, startHour, endHour } of SESSION_HOURS) {
      const start = dayStart + startHour * HOUR_MS;
      const end = dayStart + endHour * HOUR_MS;
      const clippedStart = Math.max(start, fromMs);
      const clippedEnd = Math.min(end, toMs);
      if (clippedEnd > clippedStart) {
        bands.push({ session, startMs: clippedStart, endMs: clippedEnd });
      }
    }
  }

  return bands;
}

// Intraday only -- a D1+ bar already spans every session in a single
// candle, so shading would just paint the whole chart uniformly.
const INTRADAY_TIMEFRAMES = new Set(["M1", "M5", "M30", "H1", "H4"]);
export function isIntradayTimeframe(timeframe: string): boolean {
  return INTRADAY_TIMEFRAMES.has(timeframe);
}

export const SESSION_COLORS: Record<SessionName, string> = {
  asia: "rgba(255, 193, 7, 0.07)",
  london: "rgba(41, 121, 255, 0.07)",
  newyork: "rgba(0, 200, 83, 0.07)",
};
