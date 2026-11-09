import type { SymbolCategory } from "@prisma/client";
import { checkTradingSession, sessionMinutes, tradeSessions, type SessionRow } from "@/lib/risk";

// Per-symbol trading windows for QoreBridge (auto-reconnect phase 2, owner 2026-11-09): served with every LP symbol
// in GET /api/bridge/config so the bridge knows when a symbol's market is open. It then skips logons the venue would
// refuse anyway (weekend maintenance: zero refusals, zero lock risk) and holds orders for a closed symbol.
//
// One window = one UTC day: `dayOfWeek` 0 = Sunday .. 6 = Saturday, `openUtc` inclusive, `closeUtc` exclusive, both
// "HH:MM"; "24:00" = to the end of that day. A window never crosses midnight here (a configured row that does is
// split in two), so the bridge's test is just: some window with this day and open <= now < close.
//
// Source, in the same order lib/risk.ts checkTradingSession decides it:
//   configured  the broker's TradingSession rows of kind TRADE for that symbol (they always win)
//   default     no rows: the platform's own rule (FX/metals weekly close Friday 17:00 to Sunday 17:00 New York, the
//               metals/commodities daily break, crypto never closed), resolved for the current UTC week by
//               evaluating checkTradingSession itself hour by hour. Every default boundary is a whole UTC hour
//               (the New York close hour, whole-hour breaks), so hourly sampling is exact. The windows move with US
//               daylight time twice a year, and the config version moves with them.

export type BridgeSession = { dayOfWeek: number; openUtc: string; closeUtc: string };
export type BridgeSessionsSource = "configured" | "default";

const DAY_MIN = 24 * 60;
const HOUR_MS = 3_600_000;

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Sorted by day then open; overlapping or touching windows on the same day merged. */
function normalize(windows: { day: number; open: number; close: number }[]): BridgeSession[] {
  const sorted = windows.filter((w) => w.close > w.open).sort((a, b) => a.day - b.day || a.open - b.open);
  const out: { day: number; open: number; close: number }[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && last.day === w.day && w.open <= last.close) last.close = Math.max(last.close, w.close);
    else out.push({ ...w });
  }
  return out.map((w) => ({ dayOfWeek: w.day, openUtc: hhmm(w.open), closeUtc: hhmm(w.close) }));
}

/** The admin's rows as same-day windows (a row crossing midnight becomes two; open = close is never open). */
function configuredWindows(rows: SessionRow[]): BridgeSession[] {
  const out: { day: number; open: number; close: number }[] = [];
  for (const r of rows) {
    const open = sessionMinutes(r.openTime);
    const close = sessionMinutes(r.closeTime);
    if (!Number.isFinite(open) || !Number.isFinite(close) || r.dayOfWeek < 0 || r.dayOfWeek > 6) continue; // never open
    if (close > open) out.push({ day: r.dayOfWeek, open, close });
    else if (close < open) {
      out.push({ day: r.dayOfWeek, open, close: DAY_MIN });
      if (close > 0) out.push({ day: (r.dayOfWeek + 1) % 7, open: 0, close });
    }
  }
  return normalize(out);
}

/** The platform's default rule for this symbol, for the UTC week (Sunday 00:00 to Sunday 00:00) containing `now`. */
function defaultWindows(category: SymbolCategory, symbolName: string, now: Date): BridgeSession[] {
  const weekStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - now.getUTCDay() * 24 * HOUR_MS;
  const out: { day: number; open: number; close: number }[] = [];
  for (let h = 0; h < 7 * 24; h++) {
    if (checkTradingSession([], new Date(weekStart + h * HOUR_MS), category, symbolName) !== null) continue;
    const day = Math.floor(h / 24);
    const open = (h % 24) * 60;
    out.push({ day, open, close: open + 60 });
  }
  return normalize(out);
}

export function resolveTradingWindows(
  rows: SessionRow[],
  category: SymbolCategory,
  symbolName: string,
  now: Date
): { sessionsSource: BridgeSessionsSource; sessions: BridgeSession[] } {
  // crypto is never closed, configured rows or not (checkTradingSession's isContinuouslyTraded comes first)
  const configured = category === "CRYPTO" ? [] : tradeSessions(rows);
  if (configured.length > 0) return { sessionsSource: "configured", sessions: configuredWindows(configured) };
  return { sessionsSource: "default", sessions: defaultWindows(category, symbolName, now) };
}

/** The bridge's own test, kept here so the tests can check both sides agree with checkTradingSession. */
export function windowsCover(sessions: BridgeSession[], at: Date): boolean {
  const day = at.getUTCDay();
  const m = at.getUTCHours() * 60 + at.getUTCMinutes();
  return sessions.some((s) => s.dayOfWeek === day && m >= sessionMinutes(s.openUtc) && m < sessionMinutes(s.closeUtc));
}
