import type { Prisma, PrismaClient } from "@prisma/client";
import type { CalendarEvent } from "@/lib/economic-calendar";

type Db = PrismaClient | Prisma.TransactionClient;

// web4 (issues.md 151, owner 2026-09-30): the high-impact economic event HISTORY behind the risk radar's news-trading
// flag. ForexFactory's feed is one week (Sunday to Saturday) and EconomicCalendarCache is overwritten hourly, so every
// time the week is read this keeps its HIGH-impact events for good (never deleted).
//
// Stable key: ForexFactory rows carry no id, so the key is "ff|<currency>|<title>|<UTC date of the event>|<n>", n
// numbering same-currency same-title events of one day in time order (two speeches by the same official that day).
// The time is deliberately NOT in the key: an event re-timed within its day updates eventAt in place. An event moved
// to ANOTHER day gets a new key; the old row stays (never deleted) -- a known, rare limitation of a feed with no ids.
export const NEWS_SOURCE = "forexfactory";

export function highImpactRows(events: CalendarEvent[]): { sourceKey: string; eventAt: Date; currency: string; title: string }[] {
  const high = events
    .filter((e) => String(e.impact).toLowerCase() === "high")
    .map((e) => ({ eventAt: new Date(e.time), currency: String(e.country).trim().toUpperCase(), title: String(e.event).trim() }))
    // "All" (not one currency: G20 meetings etc.) is not kept -- it cannot be matched to a symbol
    .filter((e) => !Number.isNaN(e.eventAt.getTime()) && /^[A-Z]{3}$/.test(e.currency) && e.currency !== "ALL" && e.title.length > 0)
    .sort((a, b) => a.eventAt.getTime() - b.eventAt.getTime());
  const seen = new Map<string, number>();
  return high.map((e) => {
    const base = `ff|${e.currency}|${e.title}|${e.eventAt.toISOString().slice(0, 10)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { sourceKey: `${base}|${n}`, ...e };
  });
}

/** Upserts every high-impact event of `events` into EconomicEvent. Idempotent; returns how many rows it touched. */
export async function recordHighImpactEvents(db: Db, events: CalendarEvent[]): Promise<number> {
  const rows = highImpactRows(events);
  for (const r of rows) {
    await db.economicEvent.upsert({
      where: { sourceKey: r.sourceKey },
      create: { sourceKey: r.sourceKey, source: NEWS_SOURCE, eventAt: r.eventAt, currency: r.currency, impact: "high", title: r.title },
      update: { eventAt: r.eventAt, title: r.title },
    });
  }
  return rows.length;
}

/**
 * Where the history honestly starts: the Sunday 00:00 UTC of the week of the first recording (the feed always
 * carries its whole week, so that week's events are complete). null = nothing recorded yet.
 */
export async function newsHistoryFrom(db: Db): Promise<Date | null> {
  const first = await db.economicEvent.findFirst({ orderBy: { firstSeenAt: "asc" }, select: { firstSeenAt: true } });
  if (!first) return null;
  const d = new Date(first.firstSeenAt);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}
