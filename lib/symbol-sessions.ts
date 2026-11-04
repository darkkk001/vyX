// Symbols tab (backoffice 1.0.101): the server-owned rules for a symbol's trading / quote windows.
//   - validateSessions: one validator for every route that writes sessions (PUT sessions, bulk, import)
//   - SESSION_PRESETS: the server-defined presets every app shows the same
//   - hoursSummary: the one-line hours text the Symbols list shows (the app never builds it)
// All stored times are UTC "HH:MM" (closeTime may be "24:00"); lib/risk.ts sessionCovers is the reader.

export type SessionKind = "TRADE" | "QUOTE";
export type SessionInput = { kind: SessionKind; dayOfWeek: number; openTime: string; closeTime: string };
export type RowError = { index: number; reason: string };

const OPEN_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CLOSE_RE = /^(([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
const KINDS: SessionKind[] = ["TRADE", "QUOTE"];

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Validates a list of session rows and returns the rows to store.
 *  - kind defaults to TRADE when absent (older clients), anything else must be TRADE or QUOTE
 *  - openTime HH:MM, closeTime HH:MM or 24:00, open and close must differ
 *  - a window that crosses midnight (close before open) is stored as two rows: day open..24:00 and the next day 00:00..close
 *  - two windows of the same kind may not overlap on a day (touching ends are fine); the error names the input row index
 */
export function validateSessions(raw: unknown): { rows: SessionInput[]; rowErrors: RowError[] } {
  const rowErrors: RowError[] = [];
  const out: { row: SessionInput; index: number }[] = [];
  if (!Array.isArray(raw)) return { rows: [], rowErrors: [{ index: -1, reason: "sessions must be an array" }] };

  raw.forEach((s, index) => {
    const kind = (s?.kind === undefined || s?.kind === null ? "TRADE" : s.kind) as SessionKind;
    const dayOfWeek = typeof s?.dayOfWeek === "number" ? s.dayOfWeek : typeof s?.dayOfWeek === "string" && s.dayOfWeek.trim() !== "" ? Number(s.dayOfWeek) : NaN;
    const openTime = typeof s?.openTime === "string" ? s.openTime : "";
    const closeTime = typeof s?.closeTime === "string" ? s.closeTime : "";
    if (!KINDS.includes(kind)) return void rowErrors.push({ index, reason: "kind must be TRADE or QUOTE" });
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return void rowErrors.push({ index, reason: "dayOfWeek must be 0-6 (0 = Sunday)" });
    if (!OPEN_RE.test(openTime)) return void rowErrors.push({ index, reason: "openTime must be HH:MM (00:00-23:59)" });
    if (!CLOSE_RE.test(closeTime)) return void rowErrors.push({ index, reason: "closeTime must be HH:MM or 24:00" });
    if (openTime === closeTime) return void rowErrors.push({ index, reason: "closeTime must differ from openTime (use 00:00-24:00 for the whole day)" });
    if (minutes(closeTime) < minutes(openTime)) {
      // crosses midnight: two rows
      out.push({ row: { kind, dayOfWeek, openTime, closeTime: "24:00" }, index });
      if (closeTime !== "00:00") out.push({ row: { kind, dayOfWeek: (dayOfWeek + 1) % 7, openTime: "00:00", closeTime }, index });
    } else {
      out.push({ row: { kind, dayOfWeek, openTime, closeTime }, index });
    }
  });

  // overlap per day and kind (after the split); report the later row
  const seen = new Map<string, { open: number; close: number; index: number }[]>();
  const reported = new Set<number>();
  for (const { row, index } of out) {
    const key = `${row.kind}:${row.dayOfWeek}`;
    const open = minutes(row.openTime);
    const close = minutes(row.closeTime);
    const list = seen.get(key) ?? [];
    const clash = list.find((o) => open < o.close && o.open < close);
    if (clash && !reported.has(index)) {
      reported.add(index);
      rowErrors.push({ index, reason: `overlaps row ${clash.index} on the same day (${row.kind})` });
    }
    list.push({ open, close, index });
    seen.set(key, list);
  }

  rowErrors.sort((a, b) => a.index - b.index);
  const rows = out.map((o) => o.row).sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.openTime.localeCompare(b.openTime) || a.kind.localeCompare(b.kind));
  return { rows, rowErrors };
}

// ---- presets (UTC, server-owned constants) ----
// New York 17:00 is 22:00 UTC in winter, so the week presets are written for winter time (the broker edits a row if it
// wants the summer hour); this is the same anchor lib/risk.ts uses for the default week.
export type SessionPreset = { id: string; name: string; sessions: SessionInput[] };

function week(days: number[], windows: [string, string][]): SessionInput[] {
  return days.flatMap((dayOfWeek) => windows.map(([openTime, closeTime]) => ({ kind: "TRADE" as const, dayOfWeek, openTime, closeTime })));
}

export const SESSION_PRESETS: SessionPreset[] = [
  {
    id: "fx-week",
    name: "FX week",
    sessions: [...week([0], [["22:00", "24:00"]]), ...week([1, 2, 3, 4], [["00:00", "24:00"]]), ...week([5], [["00:00", "22:00"]])],
  },
  { id: "24-7", name: "24/7", sessions: week([0, 1, 2, 3, 4, 5, 6], [["00:00", "24:00"]]) },
  {
    // the FX week with the daily one-hour settlement break at 17:00-18:00 New York (22:00-23:00 UTC), Sun-Thu
    id: "metals",
    name: "Metals",
    sessions: [...week([0], [["23:00", "24:00"]]), ...week([1, 2, 3, 4], [["00:00", "22:00"], ["23:00", "24:00"]]), ...week([5], [["00:00", "22:00"]])],
  },
  { id: "indices", name: "Indices", sessions: week([1, 2, 3, 4, 5], [["01:00", "22:00"]]) },
  { id: "crypto", name: "Crypto", sessions: week([0, 1, 2, 3, 4, 5, 6], [["00:00", "24:00"]]) },
];

// ---- hours summary ----
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

/** Minutes the zone is ahead of UTC at `now` (0 for UTC or an unknown zone). */
export function zoneOffsetMinutes(timeZone: string | null | undefined, now: Date): number {
  if (!timeZone) return 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return Math.round((asUtc - Math.floor(now.getTime() / 60000) * 60000) / 60000);
  } catch {
    return 0;
  }
}

function zoneLabel(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  if (timeZone === "America/New_York") return "NY";
  if (/^(UTC|Etc\/UTC|Etc\/GMT)$/.test(timeZone)) return "UTC";
  return timeZone.split("/").pop()!.replace(/_/g, " ");
}

function hh(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? String(h) : `${h}:${String(m).padStart(2, "0")}`;
}
function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** The windows of one local day as text: "24h", "24h · break 17-18", "from 17:00", "until 17:00" or "08:00-17:00, 18:00-22:00". */
function dayText(windows: [number, number][]): string {
  if (windows.length === 1 && windows[0][0] === 0 && windows[0][1] === 1440) return "24h";
  if (windows.length === 2 && windows[0][0] === 0 && windows[1][1] === 1440) return `24h · break ${hh(windows[0][1])}-${hh(windows[1][0])}`;
  return windows
    .map(([a, b]) => (a === 0 ? `until ${hhmm(b)}` : b === 1440 ? `from ${hhmm(a)}` : `${hhmm(a)}-${hhmm(b)}`))
    .join(", ");
}

function weekText(rows: { dayOfWeek: number; openTime: string; closeTime: string }[], offset: number): string {
  // a week of minutes in UTC, shifted into the display zone; ws = Sunday 00:00 of the display zone
  const WEEK = 7 * 1440;
  const grid = new Array<boolean>(WEEK).fill(false);
  for (const r of rows) {
    const open = minutes(r.openTime);
    const close = minutes(r.closeTime);
    const spans: [number, number][] = close > open ? [[open, close]] : close < open ? [[open, 1440], [0, close]] : [];
    spans.forEach(([a, b], i) => {
      const day = i === 0 ? r.dayOfWeek : (r.dayOfWeek + 1) % 7;
      for (let m = a; m < b; m++) grid[(((day * 1440 + m + offset) % WEEK) + WEEK) % WEEK] = true;
    });
  }
  const perDay = new Map<number, string>();
  for (let d = 0; d < 7; d++) {
    const windows: [number, number][] = [];
    let start = -1;
    for (let m = 0; m <= 1440; m++) {
      const on = m < 1440 && grid[d * 1440 + m];
      if (on && start < 0) start = m;
      if (!on && start >= 0) {
        windows.push([start, m]);
        start = -1;
      }
    }
    if (windows.length > 0) perDay.set(d, dayText(windows));
  }
  if (perDay.size === 7 && new Set(perDay.values()).size === 1 && perDay.get(0) === "24h") return "24/7";
  // consecutive days (Mon..Sun order) with the same text share one label
  const parts: string[] = [];
  let i = 0;
  while (i < ORDER.length) {
    const text = perDay.get(ORDER[i]);
    if (text === undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < ORDER.length && perDay.get(ORDER[j + 1]) === text) j++;
    parts.push(`${i === j ? DAY_NAMES[ORDER[i]] : `${DAY_NAMES[ORDER[i]]}-${DAY_NAMES[ORDER[j]]}`} ${text}`);
    i = j + 1;
  }
  return parts.join("; ");
}

/**
 * The hours line of one symbol. Times are shown in the broker's zone (UTC when it has none).
 *  - no TRADE rows: the default week text for the category (crypto 24/7, the FX week, metals / commodities with their daily break)
 *  - TRADE rows: the configured week; QUOTE rows, when there are any, add " · quotes <their week>"
 */
export function hoursSummary(
  sessions: { kind?: string; dayOfWeek: number; openTime: string; closeTime: string }[],
  opts: { category: string; timeZone?: string | null; now?: Date }
): string {
  const now = opts.now ?? new Date();
  const label = zoneLabel(opts.timeZone);
  const trade = sessions.filter((s) => s.kind === undefined || s.kind === "TRADE");
  const quote = sessions.filter((s) => s.kind === "QUOTE");
  let text: string;
  if (trade.length === 0) {
    if (opts.category === "CRYPTO") text = "24/7";
    else {
      // the default week (lib/risk.ts): open Sunday 17:00 to Friday 17:00 New York, in New York time whatever the display zone
      const brk = opts.category === "METALS" || opts.category === "COMMODITIES" ? " · break 17-18 NY" : "";
      text = `Sun 17:00 - Fri 17:00 NY${brk}`;
    }
    return quote.length > 0 ? `${text} · quotes ${weekText(quote, zoneOffsetMinutes(opts.timeZone, now))} ${label}` : text;
  }
  const offset = zoneOffsetMinutes(opts.timeZone, now);
  const week = weekText(trade, offset);
  if (week === "") return "No trading hours";
  text = week === "24/7" ? week : `${week} ${label}`;
  if (quote.length > 0) text += ` · quotes ${weekText(quote, offset)}`;
  return text;
}
