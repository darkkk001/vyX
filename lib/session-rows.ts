// Trading-session rows for the WebTrader's SESSIONS section, laid out like the native terminal's: each session either
// OPEN or the UTC time it opens next and how long until then ("22:00 · 6H21M").
//
// Standard forex session hours in UTC, approximate: regional DST shifts move them by about an hour a few weeks a year,
// the same simplification most retail platforms make for a glance value like this.
export const SESSIONS = [
  { name: "Sydney", start: 22, end: 7 },
  { name: "Tokyo", start: 0, end: 9 },
  { name: "London", start: 8, end: 17 },
  { name: "New York", start: 13, end: 22 },
] as const;

export type SessionRow = { name: string; open: boolean; opensAt: string; opensIn: string };

export function isSessionOpen(hourUtc: number, start: number, end: number): boolean {
  return start < end ? hourUtc >= start && hourUtc < end : hourUtc >= start || hourUtc < end;
}

export function sessionRows(now: Date): SessionRow[] {
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return SESSIONS.map((s) => {
    const open = isSessionOpen(now.getUTCHours(), s.start, s.end);
    const minutes = (s.start * 60 - minuteOfDay + 24 * 60) % (24 * 60);
    return {
      name: s.name,
      open,
      opensAt: `${String(s.start).padStart(2, "0")}:00`,
      opensIn: `${Math.floor(minutes / 60)}H${String(minutes % 60).padStart(2, "0")}M`,
    };
  });
}

export function utcClock(now: Date): string {
  return `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
}
