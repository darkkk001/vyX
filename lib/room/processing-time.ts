// A deposit method's processing time as the broker wrote it ("Instant–15 min", "Instant-1 hour", "1-24 hours",
// "1 hour-1 day") -> its upper bound in seconds, for the Deposit confirmation countdown (owner 2026-11-10). The last
// "<number> <unit>" in the text is the maximum. Nothing to read ("Same day", empty): null, and the card shows no countdown.
const UNIT: Record<string, number> = { m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 };

export function maxProcessingSeconds(text: string | null | undefined): number | null {
  if (!text) return null;
  const all = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:business\s+|working\s+)?(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)\b/gi)];
  const last = all[all.length - 1];
  if (!last) return null;
  const s = Math.round(Number(last[1]) * UNIT[last[2].toLowerCase()]);
  return s > 0 ? s : null;
}

/** "15 minutes", "1 hour", "24 hours", "1 day": the line under the countdown. */
export function durationWords(seconds: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (seconds % 86400 === 0) return plural(seconds / 86400, "day");
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  return plural(Math.max(1, Math.round(seconds / 60)), "minute");
}

/** The countdown: m:ss under an hour (15:00, 0:00), h:mm:ss above. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}
